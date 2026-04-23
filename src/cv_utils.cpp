#include "cv_utils.hpp"
#include <algorithm>
#include <stdexcept>

cv::Mat imreadRGB(const std::string &filename){
    cv::Mat cImg = cv::imread(filename);

    if (cImg.empty()){
        throw std::runtime_error("Cannot read " + filename + " - make sure the path to your images is correct");
    }

    cv::cvtColor(cImg, cImg, cv::COLOR_BGR2RGB);
    return cImg;
}

void imwriteRGB(const std::string &filename, const cv::Mat &image){
    cv::Mat rgb;
    cv::cvtColor(image, rgb, cv::COLOR_RGB2BGR);
    cv::imwrite(filename, rgb);
}

cv::Mat floatNxNtensorToMat(const torch::Tensor &t){
    return cv::Mat(t.size(0), t.size(1), CV_32F, t.data_ptr());
}

torch::Tensor floatNxNMatToTensor(const cv::Mat &m){
    return torch::from_blob(m.data, { m.rows, m.cols }, torch::kFloat32).clone();
}

cv::Mat tensorToImage(const torch::Tensor &t){
    torch::Tensor cpuTensor = t.detach().cpu().contiguous();
    int h = cpuTensor.sizes()[0];
    int w = cpuTensor.sizes()[1];
    int c = cpuTensor.sizes()[2];

    int type = CV_8UC3;
    if (c != 3) throw std::runtime_error("Only images with 3 channels are supported");

    cv::Mat image(h, w, type);
    torch::Tensor scaledTensor;
    if (cpuTensor.scalar_type() == torch::kUInt8) {
        scaledTensor = cpuTensor;
    } else if (cpuTensor.is_floating_point()) {
        scaledTensor = torch::clamp(cpuTensor, 0.0, 1.0).mul(255.0).toType(torch::kU8).contiguous();
    } else {
        throw std::runtime_error("Unsupported tensor type for image conversion");
    }

    uint8_t* dataPtr = static_cast<uint8_t*>(scaledTensor.data_ptr());
    std::copy(dataPtr, dataPtr + (w * h * c), image.data);

    return image;
}

torch::Tensor imageToTensor(const cv::Mat &image){
    torch::Tensor img = torch::from_blob(
        image.data,
        { image.rows, image.cols, image.channels() },
        torch::TensorOptions().dtype(torch::kUInt8)
    );
    return img.clone();
}

