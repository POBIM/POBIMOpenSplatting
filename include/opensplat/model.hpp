#ifndef MODEL_H
#define MODEL_H

#include <iostream>
#include <torch/torch.h>
#include <torch/csrc/api/include/torch/version.h>
#include "nerfstudio.hpp"
#include "kdtree_tensor.hpp"
#include "spherical_harmonics.hpp"
#include "ssim.hpp"
#include "input_data.hpp"
#include "optim_scheduler.hpp"

using namespace torch::indexing;
using namespace torch::autograd;

struct ManualGradScaler {
    float scale;
    float growthFactor;
    float backoffFactor;
    int growthInterval;
    int unskippedSteps;
    bool enabled;

    ManualGradScaler(float initScale = 65536.0f, float growth = 2.0f, 
                     float backoff = 0.5f, int interval = 2000)
        : scale(initScale), growthFactor(growth), backoffFactor(backoff),
          growthInterval(interval), unskippedSteps(0), enabled(true) {}

    torch::Tensor scaleGradients(const torch::Tensor& loss) {
        if (!enabled) return loss;
        return loss * scale;
    }

    void unscaleGradients(torch::Tensor& grad) {
        if (!enabled || !grad.defined()) return;
        grad.div_(scale);
    }

    bool step(const std::vector<torch::Tensor>& params) {
        if (!enabled) return true;
        
        bool foundInf = false;
        for (const auto& p : params) {
            if (p.grad().defined()) {
                if (torch::isinf(p.grad()).any().item<bool>() || 
                    torch::isnan(p.grad()).any().item<bool>()) {
                    foundInf = true;
                    break;
                }
            }
        }

        if (foundInf) {
            scale *= backoffFactor;
            unskippedSteps = 0;
            return false;
        } else {
            unskippedSteps++;
            if (unskippedSteps >= growthInterval) {
                scale *= growthFactor;
                scale = std::min(scale, 65536.0f);
                unskippedSteps = 0;
            }
            return true;
        }
    }
};

torch::Tensor randomQuatTensor(long long n);
torch::Tensor projectionMatrix(float zNear, float zFar, float fovX, float fovY, float width, float height, float cx, float cy, const torch::Device &device);
torch::Tensor psnr(const torch::Tensor& rendered, const torch::Tensor& gt);
torch::Tensor l1(const torch::Tensor& rendered, const torch::Tensor& gt);

struct Model{
  Model(const InputData &inputData, int numCameras,
        int numDownscales, int resolutionSchedule, int shDegree, int shDegreeInterval, 
        int refineEvery, int warmupLength, int resetAlphaEvery, float densifyGradThresh, float densifySizeThresh, int stopScreenSizeAt, float splitScreenSize,
        int maxSteps, bool keepCrs,
        bool mixedPrecision, int fp16Level, int ampWarmup,
        const torch::Device &device) :
    numCameras(numCameras),
    numDownscales(numDownscales), resolutionSchedule(resolutionSchedule), shDegree(shDegree), shDegreeInterval(shDegreeInterval), 
    refineEvery(refineEvery), warmupLength(warmupLength), resetAlphaEvery(resetAlphaEvery), stopSplitAt(maxSteps / 2), densifyGradThresh(densifyGradThresh), densifySizeThresh(densifySizeThresh), stopScreenSizeAt(stopScreenSizeAt), splitScreenSize(splitScreenSize),
    maxSteps(maxSteps), keepCrs(keepCrs),
    mixedPrecision(mixedPrecision), fp16Level(fp16Level), ampWarmup(ampWarmup),
    device(device), ssim(11, 3), gradScaler(){

    long long numPoints = inputData.points.xyz.size(0);
    scale = inputData.scale;
    translation = inputData.translation;

    torch::manual_seed(42);

    means = inputData.points.xyz.to(device).requires_grad_();
    scales = PointsTensor(inputData.points.xyz).scales().repeat({1, 3}).log().to(device).requires_grad_();
    quats = randomQuatTensor(numPoints).to(device).requires_grad_();

    int dimSh = numShBases(shDegree);
    torch::Tensor shs = torch::zeros({numPoints, dimSh, 3}, torch::TensorOptions().dtype(torch::kFloat32).device(device));

    shs.index({Slice(), 0, Slice(None, 3)}) = rgb2sh(inputData.points.rgb.toType(torch::kFloat64) / 255.0).toType(torch::kFloat32);
    shs.index({Slice(), Slice(1, None), Slice(3, None)}) = 0.0f;

    featuresDc = shs.index({Slice(), 0, Slice()}).to(device).requires_grad_();
    featuresRest = shs.index({Slice(), Slice(1, None), Slice()}).to(device).requires_grad_();
    opacities = torch::logit(0.1f * torch::ones({numPoints, 1})).to(device).requires_grad_();
    
    if (mixedPrecision && fp16Level >= 2 && device != torch::kCPU) {
        featuresRest = featuresRest.to(torch::kFloat16).requires_grad_();
        std::cout << "Mixed Precision Level 2: featuresRest stored as FP16" << std::endl;
    }
    
    backgroundColor = torch::tensor({0.6130f, 0.0101f, 0.3984f}, device).requires_grad_();
    
    gradScaler.enabled = (mixedPrecision && device != torch::kCPU);

    setupOptimizers();
  }

  ~Model(){
    releaseOptimizers();
  }
  
  void setupOptimizers();
  void releaseOptimizers();

  torch::Tensor forward(Camera& cam, int step);
  void optimizersZeroGrad();
  void optimizersStep();
  void schedulersStep(int step);
  int getDownscaleFactor(int step);
  void afterTrain(int step);
  void save(const std::string &filename, int step);
  void savePly(const std::string &filename, int step);
  void saveSplat(const std::string &filename);
  void saveDebugPly(const std::string &filename, int step);
  int loadPly(const std::string &filename);
  torch::Tensor mainLoss(torch::Tensor &rgb, torch::Tensor &gt, float ssimWeight);

  void addToOptimizer(torch::optim::Adam *optimizer, const torch::Tensor &newParam, const torch::Tensor &idcs, int nSamples);
  void removeFromOptimizer(torch::optim::Adam *optimizer, const torch::Tensor &newParam, const torch::Tensor &deletedMask);
  torch::Tensor means;
  torch::Tensor scales;
  torch::Tensor quats;
  torch::Tensor featuresDc;
  torch::Tensor featuresRest;
  torch::Tensor opacities;

  torch::optim::Adam *meansOpt = nullptr;
  torch::optim::Adam *scalesOpt = nullptr;
  torch::optim::Adam *quatsOpt = nullptr;
  torch::optim::Adam *featuresDcOpt = nullptr;
  torch::optim::Adam *featuresRestOpt = nullptr;
  torch::optim::Adam *opacitiesOpt = nullptr;

  OptimScheduler *meansOptScheduler = nullptr;

  torch::Tensor radii; // set in forward()
  torch::Tensor xys; // set in forward()
  int lastHeight; // set in forward()
  int lastWidth; // set in forward()

  torch::Tensor xysGradNorm; // set in afterTrain()
  torch::Tensor visCounts; // set in afterTrain()  
  torch::Tensor max2DSize; // set in afterTrain()


  torch::Tensor backgroundColor;
  torch::Device device;
  SSIM ssim;

  int numCameras;
  int numDownscales;
  int resolutionSchedule;
  int shDegree;
  int shDegreeInterval;
  int refineEvery;
  int warmupLength;
  int resetAlphaEvery;
  int stopSplitAt;
  float densifyGradThresh;
  float densifySizeThresh;
  int stopScreenSizeAt;
  float splitScreenSize;
  int maxSteps;
  bool keepCrs;
  
  bool mixedPrecision;
  int fp16Level;
  int ampWarmup;
  ManualGradScaler gradScaler;

  float scale;
  torch::Tensor translation;
};


#endif
