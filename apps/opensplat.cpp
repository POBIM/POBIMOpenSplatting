#include <filesystem>
#include <fstream>
#include <algorithm>
#include <cctype>
#include <nlohmann/json.hpp>
#include "opensplat.hpp"
#include "input_data.hpp"
#include "utils.hpp"
#include "cv_utils.hpp"
#include "constants.hpp"
#include <cxxopts.hpp>

#ifdef USE_VISUALIZATION
#include "visualizer.hpp"
#endif

namespace fs = std::filesystem;
using namespace torch::indexing;

struct LiveRenderControl {
    int cameraId = -1;
    std::string imageName;
    long long version = 0;
    bool enabled = false;
};

static int progressPercent(size_t step, int totalSteps){
    if (totalSteps <= 0) return 0;
    const size_t total = static_cast<size_t>(totalSteps);
    return std::max(0, std::min(100, static_cast<int>((std::min(step, total) * 100) / total)));
}

static LiveRenderControl readLiveRenderControl(const std::string &controlPath){
    LiveRenderControl control;
    if (controlPath.empty() || !fs::exists(controlPath)) return control;

    try {
        std::ifstream input(controlPath);
        json payload = json::parse(input, nullptr, false);
        if (payload.is_discarded()) return control;

        control.cameraId = payload.value("camera_id", -1);
        control.imageName = payload.value("image_name", std::string());
        control.version = payload.value("version", 0LL);
        control.enabled = payload.value("enabled", true);
    } catch (...) {
        return LiveRenderControl();
    }

    return control;
}

static int findLiveRenderCameraIndex(const std::vector<Camera> &cams, const LiveRenderControl &control){
    if (!control.imageName.empty()) {
        for (size_t i = 0; i < cams.size(); i++) {
            if (fs::path(cams[i].filePath).filename().string() == control.imageName) {
                return static_cast<int>(i);
            }
        }
    }

    if (control.cameraId >= 0 && control.cameraId < static_cast<int>(cams.size())) {
        return control.cameraId;
    }

    return cams.empty() ? -1 : 0;
}

static std::string cameraImageName(const Camera &cam){
    return fs::path(cam.filePath).filename().string();
}

static std::string safeRenderStem(const std::string &name){
    std::string stem = fs::path(name).stem().string();
    if (stem.empty()) stem = "camera";
    for (char &ch : stem) {
        if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_') {
            ch = '_';
        }
    }
    return stem;
}

static void writeLiveRender(Model &model,
                            Camera &cam,
                            int cameraIndex,
                            size_t step,
                            int totalSteps,
                            const fs::path &renderDir,
                            const LiveRenderControl &control){
    fs::create_directories(renderDir);

    const std::string imageName = cameraImageName(cam);
    const std::string filename = "live_" + safeRenderStem(imageName) + "_" + std::to_string(step) + ".jpg";
    const fs::path outputPath = renderDir / filename;

    torch::Tensor rgb = model.forward(cam, static_cast<int>(step));
    cv::Mat image = tensorToImage(rgb.detach().cpu());
    cv::cvtColor(image, image, cv::COLOR_RGB2BGR);
    cv::imwrite(outputPath.string(), image, {cv::IMWRITE_JPEG_QUALITY, 82});

    json payload = {
        {"camera_id", cameraIndex},
        {"image_name", imageName},
        {"filename", filename},
        {"iteration", step},
        {"total_iterations", totalSteps},
        {"progress_percent", progressPercent(step, totalSteps)},
        {"width", cam.width},
        {"height", cam.height},
        {"version", control.version},
    };

    std::cout << "LIVE_RENDER " << payload.dump() << std::endl;
}

int main(int argc, char *argv[]){
    cxxopts::Options options("opensplat", "Open Source 3D Gaussian Splats generator - " APP_VERSION);
    options.add_options()
        ("i,input", "Path to nerfstudio project", cxxopts::value<std::string>())
        ("o,output", "Path where to save output scene", cxxopts::value<std::string>()->default_value("splat.ply"))
        ("s,save-every", "Save output scene every these many steps (set to -1 to disable)", cxxopts::value<int>()->default_value("-1"))
        ("resume", "Resume training from this PLY file", cxxopts::value<std::string>()->default_value(""))
        ("val", "Withhold a camera shot for validating the scene loss")
        ("val-image", "Filename of the image to withhold for validating scene loss", cxxopts::value<std::string>()->default_value("random"))
        ("val-render", "Path of the directory where to render validation images", cxxopts::value<std::string>()->default_value(""))
        ("live-render-dir", "Directory where live training comparison renders should be written", cxxopts::value<std::string>()->default_value(""))
        ("live-render-control", "Path to JSON control file for selecting the live render camera", cxxopts::value<std::string>()->default_value(""))
        ("live-render-every-percent", "Render live training comparison every N percent of progress", cxxopts::value<int>()->default_value("2"))
        ("render-only", "Load --resume PLY, render the selected live preview camera, and exit")
        ("keep-crs", "Retain the project input's coordinate reference system")
        ("cpu", "Force CPU execution")
        ("has-visualization", "Enable the Pangolin visualizer when visualization support is built")
        
        ("n,num-iters", "Number of iterations to run", cxxopts::value<int>()->default_value("30000"))
        ("d,downscale-factor", "Scale input images by this factor.", cxxopts::value<float>()->default_value("1"))
        ("num-downscales", "Number of images downscales to use. After being scaled by [downscale-factor], images are initially scaled by a further (2^[num-downscales]) and the scale is increased every [resolution-schedule]", cxxopts::value<int>()->default_value("2"))
        ("resolution-schedule", "Double the image resolution every these many steps", cxxopts::value<int>()->default_value("3000"))
        ("sh-degree", "Maximum spherical harmonics degree (must be > 0)", cxxopts::value<int>()->default_value("3"))
        ("sh-degree-interval", "Increase the number of spherical harmonics degree after these many steps (will not exceed [sh-degree])", cxxopts::value<int>()->default_value("1000"))
        ("ssim-weight", "Weight to apply to the structural similarity loss. Set to zero to use least absolute deviation (L1) loss only", cxxopts::value<float>()->default_value("0.2"))
        ("refine-every", "Split/duplicate/prune gaussians every these many steps", cxxopts::value<int>()->default_value("100"))
        ("warmup-length", "Split/duplicate/prune gaussians only after these many steps", cxxopts::value<int>()->default_value("500"))
        ("reset-alpha-every", "Reset the opacity values of gaussians after these many refinements (not steps)", cxxopts::value<int>()->default_value("30"))
        ("densify-grad-thresh", "Threshold of the positional gradient norm (magnitude of the loss function) which when exceeded leads to a gaussian split/duplication", cxxopts::value<float>()->default_value("0.0002"))
        ("densify-size-thresh", "Gaussians' scales below this threshold are duplicated, otherwise split", cxxopts::value<float>()->default_value("0.01"))
        ("stop-screen-size-at", "Stop splitting gaussians that are larger than [split-screen-size] after these many steps", cxxopts::value<int>()->default_value("4000"))
        ("split-screen-size", "Split gaussians that are larger than this percentage of screen space", cxxopts::value<float>()->default_value("0.05"))
        ("colmap-image-path", "Override the default image path for COLMAP-based input", cxxopts::value<std::string>()->default_value(""))
        ("crop-size", "Random crop size for training (0 to disable)", cxxopts::value<int>()->default_value("0"))

        ("mixed-precision", "Enable mixed precision (FP16) training for faster speed and lower VRAM")
        ("fp16-level", "FP16 precision level: 1=AMP autocast, 2=selective storage, 3=CUDA kernels (default: 1)", cxxopts::value<int>()->default_value("1"))
        ("amp-warmup", "Number of iterations to run in FP32 before enabling AMP (default: 500)", cxxopts::value<int>()->default_value("500"))

        ("h,help", "Print usage")
        ("version", "Print version")
        ;
    options.parse_positional({ "input" });
    options.positional_help("[colmap/nerfstudio/opensfm/odm/openmvg project path]");
    cxxopts::ParseResult result;
    try {
        result = options.parse(argc, argv);
    }
    catch (const std::exception &e) {
        std::cerr << e.what() << std::endl;
        std::cerr << options.help() << std::endl;
        return EXIT_FAILURE;
    }

    if (result.count("version")){
        std::cout << APP_VERSION << std::endl;
        return EXIT_SUCCESS;
    }
    if (result.count("help") || !result.count("input")) {
        std::cout << options.help() << std::endl;
        return EXIT_SUCCESS;
    }


    const std::string projectRoot = result["input"].as<std::string>();
    const std::string outputScene = result["output"].as<std::string>();
    const int saveEvery = result["save-every"].as<int>(); 
    const std::string resume = result["resume"].as<std::string>();
    const bool validate = result.count("val") > 0 || result.count("val-render") > 0;
    const std::string valImage = result["val-image"].as<std::string>();
    const std::string valRender = result["val-render"].as<std::string>();
    if (!valRender.empty() && !fs::exists(valRender)) fs::create_directories(valRender);
    const std::string liveRenderDir = result["live-render-dir"].as<std::string>();
    const std::string liveRenderControlPath = result["live-render-control"].as<std::string>();
    const int liveRenderEveryPercent = std::max(1, result["live-render-every-percent"].as<int>());
    if (!liveRenderDir.empty() && !fs::exists(liveRenderDir)) fs::create_directories(liveRenderDir);
    const bool renderOnly = result.count("render-only") > 0;
    const bool keepCrs = result.count("keep-crs") > 0;
    const bool hasVisualization = result.count("has-visualization") > 0;
    const float downScaleFactor = (std::max)(result["downscale-factor"].as<float>(), 1.0f);
    const int numIters = result["num-iters"].as<int>();
    const int numDownscales = result["num-downscales"].as<int>();
    const int resolutionSchedule = result["resolution-schedule"].as<int>();
    const int shDegree = result["sh-degree"].as<int>();
    const int shDegreeInterval = result["sh-degree-interval"].as<int>();
    const float ssimWeight = result["ssim-weight"].as<float>();
    const int refineEvery = result["refine-every"].as<int>();
    const int warmupLength = result["warmup-length"].as<int>();
    const int resetAlphaEvery = result["reset-alpha-every"].as<int>();
    const float densifyGradThresh = result["densify-grad-thresh"].as<float>();
    const float densifySizeThresh = result["densify-size-thresh"].as<float>();
    const int stopScreenSizeAt = result["stop-screen-size-at"].as<int>();
    const float splitScreenSize = result["split-screen-size"].as<float>();
    const std::string colmapImageSourcePath = result["colmap-image-path"].as<std::string>();
    const int cropSize = result["crop-size"].as<int>();
    
    // Mixed precision options
    const bool mixedPrecision = result.count("mixed-precision") > 0;
    const int fp16Level = result["fp16-level"].as<int>();
    const int ampWarmup = result["amp-warmup"].as<int>();

    torch::Device device = torch::kCPU;
    int displayStep = 10;

    if (torch::hasCUDA() && result.count("cpu") == 0) {
        std::cout << "Using CUDA" << std::endl;
        device = torch::kCUDA;
    } else if (torch::hasMPS() && result.count("cpu") == 0) {
        std::cout << "Using MPS" << std::endl;
        device = torch::kMPS;
    }else{
        std::cout << "Using CPU" << std::endl;
        displayStep = 1;
    }

    if (mixedPrecision && device != torch::kCPU) {
        std::cout << "Mixed Precision: ENABLED (Level " << fp16Level << ", warmup " << ampWarmup << " iters)" << std::endl;
    } else if (mixedPrecision && device == torch::kCPU) {
        std::cout << "Mixed Precision: DISABLED (CPU mode does not support FP16)" << std::endl;
    }

#ifdef USE_VISUALIZATION
    Visualizer visualizer;
    if (hasVisualization) {
        visualizer.Initialize(numIters);
    }
#endif

    try{
        InputData inputData = inputDataFromX(projectRoot, colmapImageSourcePath);

        // Validate all image files exist before loading
        std::vector<std::string> missingImages;
        for (const Camera &cam : inputData.cameras) {
            if (!fs::exists(cam.filePath)) {
                missingImages.push_back(cam.filePath);
            }
        }
        if (!missingImages.empty()) {
            std::string errorMsg = "Missing image files (" + std::to_string(missingImages.size()) + " not found):\n";
            for (size_t i = 0; i < std::min(missingImages.size(), static_cast<size_t>(5)); i++) {
                errorMsg += "  - " + missingImages[i] + "\n";
            }
            if (missingImages.size() > 5) {
                errorMsg += "  ... and " + std::to_string(missingImages.size() - 5) + " more\n";
            }
            errorMsg += "Make sure your COLMAP images.bin references existing image files.";
            throw std::runtime_error(errorMsg);
        }

        for (Camera &cam : inputData.cameras) {
            cam.loadImage(downScaleFactor);
        }

        // Withhold a validation camera if necessary
        auto t = inputData.getCameras(validate, valImage);
        std::vector<Camera> cams = std::get<0>(t);
        Camera *valCam = std::get<1>(t);

        Model model(inputData,
                    cams.size(),
                    numDownscales, resolutionSchedule, shDegree, shDegreeInterval, 
                    refineEvery, warmupLength, resetAlphaEvery, densifyGradThresh, densifySizeThresh, stopScreenSizeAt, splitScreenSize,
                    numIters, keepCrs,
                    mixedPrecision, fp16Level, ampWarmup,
                    device);

        std::vector< size_t > camIndices( cams.size() );
        std::iota( camIndices.begin(), camIndices.end(), 0 );
        InfiniteRandomIterator<size_t> camsIter( camIndices );

        int imageSize = -1;
        size_t step = 1;

        int loadedIteration = -1;
        if (resume != ""){
            loadedIteration = model.loadPly(resume);
            step = loadedIteration + 1;
        }

        if (renderOnly) {
            if (resume.empty()) {
                throw std::runtime_error("--render-only requires --resume to point at a trained PLY");
            }
            if (liveRenderDir.empty()) {
                throw std::runtime_error("--render-only requires --live-render-dir");
            }

            LiveRenderControl control;
            if (!liveRenderControlPath.empty()) {
                control = readLiveRenderControl(liveRenderControlPath);
                if (!control.enabled) {
                    throw std::runtime_error("Live render control is disabled or unreadable");
                }
            } else {
                control.enabled = true;
            }

            int liveCamIndex = findLiveRenderCameraIndex(cams, control);
            if (liveCamIndex < 0) {
                throw std::runtime_error("No registered camera is available for render-only preview");
            }

            int renderStep = loadedIteration > 0 ? loadedIteration : std::max(1, numIters);
            writeLiveRender(
                    model,
                    cams[liveCamIndex],
                    liveCamIndex,
                    static_cast<size_t>(renderStep),
                    std::max(numIters, renderStep),
                    fs::path(liveRenderDir),
                    control);
            return EXIT_SUCCESS;
        }

        long long lastLiveRenderControlVersion = -1;
        int lastLiveRenderMilestone = -1;

        for (; step <= numIters; step++){
            Camera& cam = cams[ camsIter.next() ];

            model.optimizersZeroGrad();

            Camera* trainCam = &cam;
            Camera croppedCam;
            torch::Tensor gt;
            
            int scaleFactor = model.getDownscaleFactor(step);

            if (cropSize > 0){
                int currentW = cam.width / scaleFactor;
                int currentH = cam.height / scaleFactor;

                if (cropSize < currentW && cropSize < currentH){
                    croppedCam = cam;
                    trainCam = &croppedCam;

                    int maxOffX = currentW - cropSize;
                    int maxOffY = currentH - cropSize;

                    int offX = rand() % (maxOffX + 1);
                    int offY = rand() % (maxOffY + 1);

                    croppedCam.width = cropSize * scaleFactor;
                    croppedCam.height = cropSize * scaleFactor;
                    croppedCam.cx = cam.cx - (offX * scaleFactor);
                    croppedCam.cy = cam.cy - (offY * scaleFactor);

                    // Crop GT from CPU before sending to GPU
                    torch::Tensor fullGt = cam.getImage(scaleFactor);
                    gt = fullGt.index({
                        Slice(offY, offY + cropSize),
                        Slice(offX, offX + cropSize)
                    });
                }else{
                    gt = cam.getImage(scaleFactor);
                }
            }else{
                gt = cam.getImage(scaleFactor);
            }

            torch::Tensor rgb = model.forward(*trainCam, step);
            gt = gt.to(device);

            torch::Tensor mainLoss = model.mainLoss(rgb, gt, ssimWeight);
            
            bool useAMP = mixedPrecision && device != torch::kCPU && step >= ampWarmup;
            torch::Tensor scaledLoss = useAMP ? model.gradScaler.scaleGradients(mainLoss) : mainLoss;
            scaledLoss.backward();
            
            bool shouldStep = true;
            if (useAMP) {
                std::vector<torch::Tensor> params = {model.means, model.scales, model.quats, 
                                                     model.featuresDc, model.featuresRest, model.opacities};
                for (auto& p : params) {
                    if (p.grad().defined()) {
                        model.gradScaler.unscaleGradients(p.mutable_grad());
                    }
                }
                shouldStep = model.gradScaler.step(params);
            }
            
            if (step % displayStep == 0) {
                const float percentage = static_cast<float>(step) / numIters;
                std::cout << "Step " << step << ": " << mainLoss.item<float>() << " (" << floor(percentage * 100) << "%)";
                if (useAMP) std::cout << " [AMP scale=" << model.gradScaler.scale << "]";
                std::cout << std::endl;
            }

            if (shouldStep) {
                model.optimizersStep();
            }
            model.schedulersStep(step);
            model.afterTrain(step);

            if (saveEvery > 0 && step % saveEvery == 0){
                fs::path p(outputScene);
                model.save(p.replace_filename(fs::path(p.stem().string() + "_" + std::to_string(step) + p.extension().string())).string(), step);
            }

            if (!valRender.empty() && step % 10 == 0){
                torch::Tensor rgb = model.forward(*valCam, step);
                cv::Mat image = tensorToImage(rgb.detach().cpu());
                cv::cvtColor(image, image, cv::COLOR_RGB2BGR);
                cv::imwrite((fs::path(valRender) / (std::to_string(step) + ".png")).string(), image);
            }

            if (!liveRenderDir.empty() && !liveRenderControlPath.empty()){
                LiveRenderControl control = readLiveRenderControl(liveRenderControlPath);
                if (control.enabled) {
                    const int milestone = progressPercent(step, numIters) / liveRenderEveryPercent;
                    const bool selectionChanged = control.version != lastLiveRenderControlVersion;
                    const bool milestoneChanged = milestone > lastLiveRenderMilestone;
                    if (selectionChanged || milestoneChanged) {
                        int liveCamIndex = findLiveRenderCameraIndex(cams, control);
                        if (liveCamIndex >= 0) {
                            writeLiveRender(model, cams[liveCamIndex], liveCamIndex, step, numIters, fs::path(liveRenderDir), control);
                            lastLiveRenderControlVersion = control.version;
                            lastLiveRenderMilestone = milestone;
                        }
                    }
                }
            }

#ifdef USE_VISUALIZATION
            if (hasVisualization) {
                visualizer.SetInitialGaussianNum(inputData.points.xyz.size(0));
                visualizer.SetLoss(step, mainLoss.item<float>());
                visualizer.SetGaussians(model.means, model.scales, model.featuresDc,
                                        model.opacities);
                visualizer.SetImage(rgb, gt);
                visualizer.Draw();
            }
#endif
        }

        inputData.saveCameras((fs::path(outputScene).parent_path() / "cameras.json").string(), keepCrs);
        model.save(outputScene, numIters);
        // model.saveDebugPly("debug.ply", numIters);

        // Validate
        if (valCam != nullptr){
            torch::Tensor rgb = model.forward(*valCam, numIters);
            torch::Tensor gt = valCam->getImage(model.getDownscaleFactor(numIters)).to(device);
            std::cout << valCam->filePath << " validation loss: " << model.mainLoss(rgb, gt, ssimWeight).item<float>() << std::endl; 
        }
    }catch(const std::exception &e){
        std::cerr << e.what() << std::endl;
        exit(1);
    }
}
