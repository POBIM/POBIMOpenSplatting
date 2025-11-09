'use client';

import { useState, useCallback } from 'react';
import { Upload, FileVideo, Image, CheckCircle, AlertCircle, Settings, Clock, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function UploadPage() {
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState({
    project_name: '',
    quality_mode: 'high',
    camera_model: 'SIMPLE_RADIAL',
    matcher_type: 'sequential',
    extraction_mode: 'fps',
    max_frames: 100,
    target_fps: 2.0,
    quality: 100,
    preview_count: 10
  });

  // Custom parameters - starts with High quality (7000 iter) baseline
  const [customParams, setCustomParams] = useState({
    // OpenSplat Training
    iterations: 7000,
    densify_grad_threshold: 0.00015,
    refine_every: 75,
    warmup_length: 750,
    ssim_weight: 0.25,
    // OpenSplat Learning Rates (High quality settings)
    learning_rate: 0.0025,
    position_lr_init: 0.00016,
    position_lr_final: 0.0000016,
    feature_lr: 0.0025,
    opacity_lr: 0.05,
    scaling_lr: 0.005,
    rotation_lr: 0.001,
    percent_dense: 0.01,
    // COLMAP SIFT Feature Extraction
    peak_threshold: 0.01,
    edge_threshold: 15,
    max_num_orientations: 2,
    // COLMAP Feature Extraction & Matching
    max_num_features: 12288,
    max_num_matches: 32768,
    sequential_overlap: 18,
    // COLMAP Mapper (Reconstruction)
    min_num_matches: 16,
    max_num_models: 40,
    init_num_trials: 225
  });

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      handleFileSelect(droppedFiles);
    }
  }, []);

  const handleFileSelect = (selectedFiles: File[]) => {
    const validTypes = ['video/mp4', 'video/avi', 'video/mov', 'image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'image/bmp', 'image/tiff'];
    const validExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff'];

    const validFiles = selectedFiles.filter(file => {
      const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
      return validTypes.includes(file.type) || validExtensions.includes(fileExtension);
    });

    if (validFiles.length === 0) {
      setError('Please select valid video or image files');
      return;
    }

    const maxSize = 5 * 1024 * 1024 * 1024; // 5GB
    const oversizedFiles = validFiles.filter(file => file.size > maxSize);
    if (oversizedFiles.length > 0) {
      setError(`Files too large: ${oversizedFiles.map(f => f.name).join(', ')}. Maximum size is 5GB per file.`);
      return;
    }

    setFiles(validFiles);
    setError(null);
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    setUploading(true);
    setError(null);
    setUploadProgress(0);

    let progressInterval: ReturnType<typeof setInterval> | null = null;

    try {
      // Simulate upload progress while backend processes the form data
      progressInterval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 90));
      }, 200);

      // Add custom parameters to config if custom mode is selected
      const uploadConfig = {
        ...config,
        ...(config.quality_mode === 'custom' && {
          // OpenSplat Training
          iterations: customParams.iterations,
          densify_grad_threshold: customParams.densify_grad_threshold,
          refine_every: customParams.refine_every,
          warmup_length: customParams.warmup_length,
          ssim_weight: customParams.ssim_weight,
          // OpenSplat Learning Rates
          learning_rate: customParams.learning_rate,
          position_lr_init: customParams.position_lr_init,
          position_lr_final: customParams.position_lr_final,
          feature_lr: customParams.feature_lr,
          opacity_lr: customParams.opacity_lr,
          scaling_lr: customParams.scaling_lr,
          rotation_lr: customParams.rotation_lr,
          percent_dense: customParams.percent_dense,
          // COLMAP SIFT Feature Parameters
          peak_threshold: customParams.peak_threshold,
          edge_threshold: customParams.edge_threshold,
          max_num_orientations: customParams.max_num_orientations,
          // COLMAP Feature Extraction & Matching
          max_num_features: customParams.max_num_features,
          max_num_matches: customParams.max_num_matches,
          sequential_overlap: customParams.sequential_overlap,
          // COLMAP Mapper (Reconstruction)
          min_num_matches: customParams.min_num_matches,
          max_num_models: customParams.max_num_models,
          init_num_trials: customParams.init_num_trials
        })
      };

      const result = await api.upload(files, uploadConfig);
      setUploadProgress(100);

      console.log('Upload result:', result);

      if (result.project_id) {
        // Redirect directly to live processing tracker
        console.log('Redirecting to:', `/processing/${result.project_id}`);
        router.push(`/processing/${result.project_id}`);
      } else {
        throw new Error(result.error || 'Upload failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploading(false);
      setUploadProgress(0);
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  const hasVideo = files.some(file => file.type.startsWith('video/'));
  const hasImages = files.some(file => file.type.startsWith('image/'));
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  const getQualityInfo = (mode: string) => {
    const info = {
      fast: { iterations: 500, time: '~30s-2m', desc: 'Quick preview' },
      balanced: { iterations: 7000, time: '~5-15m', desc: 'High quality (NEW default)' },
      high: { iterations: 7000, time: '~5-15m', desc: 'High detail' },
      ultra: { iterations: 15000, time: '~10-30m', desc: 'Maximum quality' },
      professional: { iterations: 30000, time: '~20-60m', desc: 'Professional grade for 4K+ images' },
      ultra_professional: { iterations: 60000, time: '~40-90m', desc: 'Ultra professional grade for highest quality' },
      robust: { iterations: 7000, time: '~5-15m', desc: 'For difficult images' }
    };
    return info[mode as keyof typeof info] || info.balanced;
  };

  return (
    <div className="max-w-5xl mx-auto p-8 bg-white min-h-screen">
      <div className="mb-12">
        <h1 className="text-3xl font-bold text-black mb-2">Upload Media</h1>
        <p className="text-gray-600">Upload images or videos for 3D reconstruction</p>
      </div>

      <div
        className={`border-2 border-dashed rounded-2xl p-16 text-center transition-all ${
          isDragging
            ? 'border-black bg-gray-50'
            : 'border-gray-200 hover:border-gray-300'
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {files.length === 0 ? (
          <>
            <Upload className="mx-auto h-16 w-16 text-gray-300 mb-6" />
            <p className="text-xl font-semibold text-black mb-2">
              Drop your files here or click to browse
            </p>
            <p className="text-sm text-gray-500 mb-6">
              Supports MP4, AVI, MOV, JPG, PNG, WebP, TIFF files up to 5GB each
            </p>
            <input
              type="file"
              accept="video/*,image/*"
              multiple
              onChange={(e) => e.target.files && handleFileSelect(Array.from(e.target.files))}
              className="hidden"
              id="file-input"
            />
            <label
              htmlFor="file-input"
              className="btn-primary cursor-pointer"
            >
              Choose Files
            </label>
          </>
        ) : (
          <div className="space-y-6">
            {/* File List */}
            <div className="bg-gray-50 rounded-2xl p-6">
              <h4 className="font-semibold text-black mb-4">Selected Files ({files.length})</h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {files.map((file, index) => (
                  <div key={index} className="flex items-center justify-between bg-white p-4 rounded-xl border border-gray-200">
                    <div className="flex items-center space-x-4">
                      {file.type.startsWith('video/') ? (
                        <FileVideo className="h-5 w-5 text-black" />
                      ) : (
                        <Image className="h-5 w-5 text-black" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-black truncate">{file.name}</p>
                        <p className="text-xs text-gray-500">
                          {formatFileSize(file.size)} • {file.type.startsWith('video/') ? 'Video' : 'Image'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => removeFile(index)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <AlertCircle className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-2">Total size: {formatFileSize(totalSize)}</p>
            </div>

            {/* Configuration Options */}
            <div className="space-y-6">
              {/* Project Details */}
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-black mb-2">Project Name</label>
                  <input
                    type="text"
                    value={config.project_name}
                    onChange={(e) => setConfig({...config, project_name: e.target.value})}
                    className="input"
                    placeholder="My Awesome 3D Model"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-black mb-2">Quality Preset</label>
                  <select
                    value={config.quality_mode}
                    onChange={(e) => setConfig({...config, quality_mode: e.target.value})}
                    className="input"
                  >
                    <option value="high">🎯 High ({getQualityInfo('high').iterations} iter) - {getQualityInfo('high').time}</option>
                    <option value="ultra">✨ Ultra ({getQualityInfo('ultra').iterations} iter) - {getQualityInfo('ultra').time}</option>
                    <option value="professional">💎 Professional ({getQualityInfo('professional').iterations} iter) - {getQualityInfo('professional').time} - 4K+ SUPPORT</option>
                    <option value="ultra_professional">🏆 Ultra Professional ({getQualityInfo('ultra_professional').iterations} iter) - {getQualityInfo('ultra_professional').time} - HIGHEST QUALITY</option>
                    <option value="custom">⚙️ Custom - Fine-tune all parameters</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    {config.quality_mode === 'custom' ? 'Fine-tune all parameters' : getQualityInfo(config.quality_mode).desc}
                  </p>
                </div>
              </div>

              {/* Custom Parameters (only show when custom mode selected) */}
              {config.quality_mode === 'custom' && (
                <div className="bg-gray-50 rounded-2xl p-6 space-y-4 border border-gray-200">
                  <h4 className="font-semibold text-gray-900 mb-3 flex items-center">
                    <Settings className="h-5 w-5 mr-2" />
                    Advanced Parameters (starts from High quality baseline)
                  </h4>

                  {/* OpenSplat Training Parameters */}
                  <div className="border-b border-purple-200 pb-3">
                    <h5 className="text-sm font-semibold text-purple-900 mb-2">🎨 OpenSplat Training</h5>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div title="จำนวนรอบการเทรน - มากขึ้น = คุณภาพดีขึ้น แต่ใช้เวลานานขึ้น">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Training Iterations ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.iterations}
                          onChange={(e) => setCustomParams({...customParams, iterations: parseInt(e.target.value) || 7000})}
                          min="100"
                          max="50000"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = Better quality but slower (7000)</p>
                      </div>
                      <div title="ค่าเกณฑ์การเพิ่ม Gaussian splats - ต่ำกว่า = splats หนาแน่นกว่า = รายละเอียดมากขึ้น">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Densify Grad Threshold ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.densify_grad_threshold}
                          onChange={(e) => setCustomParams({...customParams, densify_grad_threshold: parseFloat(e.target.value) || 0.00015})}
                          min="0.00001"
                          max="0.001"
                          step="0.00001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↓ = Denser splats, more detail (0.00015)</p>
                      </div>
                      <div title="ความถี่การปรับแต่ง Gaussians - น้อยกว่า = ปรับบ่อยขึ้น = ละเอียดกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Refine Every (steps) ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.refine_every}
                          onChange={(e) => setCustomParams({...customParams, refine_every: parseInt(e.target.value) || 75})}
                          min="10"
                          max="500"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↓ = More frequent refinement (75)</p>
                      </div>
                      <div title="ระยะ warmup ของ learning rate - ยาวขึ้น = training เสถียรกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Warmup Length ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.warmup_length}
                          onChange={(e) => setCustomParams({...customParams, warmup_length: parseInt(e.target.value) || 750})}
                          min="100"
                          max="2000"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = More stable training (750)</p>
                      </div>
                      <div title="น้ำหนักของ SSIM loss - สูงขึ้น = รักษาโครงสร้างได้ดีกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          SSIM Weight ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.ssim_weight}
                          onChange={(e) => setCustomParams({...customParams, ssim_weight: parseFloat(e.target.value) || 0.25})}
                          min="0"
                          max="1"
                          step="0.01"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = Better structure preservation (0.25)</p>
                      </div>
                    </div>
                  </div>

                  {/* OpenSplat Learning Rates */}
                  <div className="pt-2 border-b border-purple-200 pb-3">
                    <h5 className="text-sm font-semibold text-purple-900 mb-2">📊 OpenSplat Learning Rates (High quality)</h5>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div title="Main learning rate - ต่ำกว่า = training เสถียรกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Learning Rate ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.learning_rate}
                          onChange={(e) => setCustomParams({...customParams, learning_rate: parseFloat(e.target.value) || 0.0025})}
                          min="0.0001"
                          max="0.01"
                          step="0.0001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↓ = More stable training (0.0025)</p>
                      </div>
                      <div title="Initial position learning rate">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Position LR Init ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.position_lr_init}
                          onChange={(e) => setCustomParams({...customParams, position_lr_init: parseFloat(e.target.value) || 0.00016})}
                          min="0.00001"
                          max="0.001"
                          step="0.00001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">Starting position LR (0.00016)</p>
                      </div>
                      <div title="Final position learning rate">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Position LR Final ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.position_lr_final}
                          onChange={(e) => setCustomParams({...customParams, position_lr_final: parseFloat(e.target.value) || 0.0000016})}
                          min="0.0000001"
                          max="0.0001"
                          step="0.0000001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">Ending position LR (0.0000016)</p>
                      </div>
                      <div title="Feature learning rate">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Feature LR ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.feature_lr}
                          onChange={(e) => setCustomParams({...customParams, feature_lr: parseFloat(e.target.value) || 0.0025})}
                          min="0.0001"
                          max="0.01"
                          step="0.0001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">Feature learning rate (0.0025)</p>
                      </div>
                      <div title="Opacity learning rate">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Opacity LR ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.opacity_lr}
                          onChange={(e) => setCustomParams({...customParams, opacity_lr: parseFloat(e.target.value) || 0.05})}
                          min="0.001"
                          max="0.5"
                          step="0.001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">Opacity LR (0.05)</p>
                      </div>
                      <div title="Scaling learning rate">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Scaling LR ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.scaling_lr}
                          onChange={(e) => setCustomParams({...customParams, scaling_lr: parseFloat(e.target.value) || 0.005})}
                          min="0.0001"
                          max="0.05"
                          step="0.0001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">Scaling LR (0.005)</p>
                      </div>
                      <div title="Rotation learning rate">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Rotation LR ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.rotation_lr}
                          onChange={(e) => setCustomParams({...customParams, rotation_lr: parseFloat(e.target.value) || 0.001})}
                          min="0.0001"
                          max="0.01"
                          step="0.0001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">Rotation LR (0.001)</p>
                      </div>
                      <div title="Percentage of dense points">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Percent Dense ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.percent_dense}
                          onChange={(e) => setCustomParams({...customParams, percent_dense: parseFloat(e.target.value) || 0.01})}
                          min="0.001"
                          max="0.5"
                          step="0.001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">Dense point percentage (0.01)</p>
                      </div>
                    </div>
                  </div>

                  {/* COLMAP SIFT Feature Parameters */}
                  <div className="pt-2 border-b border-purple-200 pb-3">
                    <h5 className="text-sm font-semibold text-purple-900 mb-2">🎯 COLMAP SIFT Feature Quality</h5>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div title="SIFT peak threshold - สูงขึ้น = features ที่ robust กว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Peak Threshold ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.peak_threshold}
                          onChange={(e) => setCustomParams({...customParams, peak_threshold: parseFloat(e.target.value) || 0.01})}
                          min="0.001"
                          max="0.1"
                          step="0.001"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = More robust features (0.01)</p>
                      </div>
                      <div title="SIFT edge threshold - สูงขึ้น = กรอง false edges ได้ดีกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Edge Threshold ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.edge_threshold}
                          onChange={(e) => setCustomParams({...customParams, edge_threshold: parseFloat(e.target.value) || 15})}
                          min="5"
                          max="30"
                          step="1"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = Reduce false edges (15)</p>
                      </div>
                      <div title="จำนวน orientations ต่อ keypoint - มากขึ้น = รับรู้ได้หลากหลายกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Max Num Orientations ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.max_num_orientations}
                          onChange={(e) => setCustomParams({...customParams, max_num_orientations: parseInt(e.target.value) || 2})}
                          min="1"
                          max="5"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = More orientation variety (2)</p>
                      </div>
                    </div>
                  </div>

                  {/* COLMAP Feature Extraction & Matching */}
                  <div className="pt-2 border-b border-purple-200 pb-3">
                    <h5 className="text-sm font-semibold text-purple-900 mb-2">🔍 COLMAP Feature Extraction & Matching</h5>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div title="จำนวน SIFT features สูงสุดต่อภาพ - มากขึ้น = ดึงรายละเอียดได้มากขึ้น = จับคู่ได้ดีขึ้น">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Max Features per Image ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.max_num_features}
                          onChange={(e) => setCustomParams({...customParams, max_num_features: parseInt(e.target.value) || 12288})}
                          min="1024"
                          max="32768"
                          step="1024"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = More feature points = Better coverage (12288)</p>
                      </div>
                      <div title="จำนวน match points สูงสุดต่อ image pair - มากขึ้น = การจับคู่แม่นยำกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Max Matches per Pair ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.max_num_matches}
                          onChange={(e) => setCustomParams({...customParams, max_num_matches: parseInt(e.target.value) || 32768})}
                          min="4096"
                          max="65536"
                          step="4096"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = More accurate matching (32768)</p>
                      </div>
                      <div title="จำนวนภาพที่แต่ละภาพจะจับคู่ด้วย - มากขึ้น = connectivity ดีกว่า">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Sequential Overlap ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.sequential_overlap}
                          onChange={(e) => setCustomParams({...customParams, sequential_overlap: parseInt(e.target.value) || 18})}
                          min="5"
                          max="50"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = Better image connectivity (18)</p>
                      </div>
                    </div>
                  </div>

                  {/* COLMAP Mapper (Reconstruction) */}
                  <div className="pt-2">
                    <h5 className="text-sm font-semibold text-purple-900 mb-2">🏗️ COLMAP Sparse Reconstruction (Mapper)</h5>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div title="จำนวน matches ขั้นต่ำที่ยอมรับ - น้อยกว่า = ยอมรับภาพที่ match ยากขึ้น = register ได้มากขึ้น">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Min Num Matches ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.min_num_matches}
                          onChange={(e) => setCustomParams({...customParams, min_num_matches: parseInt(e.target.value) || 16})}
                          min="6"
                          max="50"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↓ = Accept weaker matches = More images registered (16)</p>
                      </div>
                      <div title="จำนวนโมเดลสูงสุดที่ลองสร้าง - มากขึ้น = โอกาสได้โมเดลที่ดีสูงขึ้น">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Max Num Models ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.max_num_models}
                          onChange={(e) => setCustomParams({...customParams, max_num_models: parseInt(e.target.value) || 40})}
                          min="5"
                          max="100"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = Try more models = Higher chance of good result (40)</p>
                      </div>
                      <div title="จำนวนครั้งที่ลอง initialize reconstruction - มากขึ้น = โอกาสสำเร็จสูงขึ้น">
                        <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                          Init Num Trials ℹ️
                        </label>
                        <input
                          type="number"
                          value={customParams.init_num_trials}
                          onChange={(e) => setCustomParams({...customParams, init_num_trials: parseInt(e.target.value) || 225})}
                          min="50"
                          max="500"
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <p className="text-xs text-gray-500 mt-0.5">↑ = More init attempts = Higher success rate (225)</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* COLMAP Options */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Feature Matching</label>
                  <select
                    value={config.matcher_type}
                    onChange={(e) => setConfig({...config, matcher_type: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="sequential">Sequential (Fast, good for sequences)</option>
                    <option value="exhaustive">Exhaustive (Slower, better coverage)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Camera Model</label>
                  <select
                    value={config.camera_model}
                    onChange={(e) => setConfig({...config, camera_model: e.target.value})}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="SIMPLE_RADIAL">SIMPLE_RADIAL (Recommended)</option>
                    <option value="SIMPLE_PINHOLE">SIMPLE_PINHOLE</option>
                    <option value="PINHOLE">PINHOLE</option>
                    <option value="OPENCV">OPENCV</option>
                  </select>
                </div>
              </div>

              {/* Video Options */}
              {hasVideo && (
                <div className="bg-blue-50 rounded-xl p-4">
                  <h4 className="font-semibold text-gray-900 mb-3 flex items-center">
                    <FileVideo className="h-5 w-5 mr-2" />
                    Video Frame Extraction Settings
                  </h4>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Extraction Mode</label>
                      <select
                        value={config.extraction_mode}
                        onChange={(e) => setConfig({...config, extraction_mode: e.target.value})}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value="frames">Fixed Frame Count</option>
                        <option value="fps">Target FPS</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Frame Quality</label>
                      <select
                        value={config.quality}
                        onChange={(e) => setConfig({...config, quality: parseInt(e.target.value)})}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value={100}>100% (Original size)</option>
                        <option value={75}>75% (Reduced size)</option>
                        <option value={50}>50% (Smaller files)</option>
                      </select>
                    </div>
                  </div>
                  <div className="mt-4">
                    {config.extraction_mode === 'frames' ? (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Maximum Frames</label>
                        <select
                          value={config.max_frames}
                          onChange={(e) => setConfig({...config, max_frames: parseInt(e.target.value)})}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value={50}>50 frames (Quick)</option>
                          <option value={100}>100 frames (Standard)</option>
                          <option value={200}>200 frames (Detailed)</option>
                          <option value={500}>500 frames (High quality)</option>
                        </select>
                      </div>
                    ) : (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Target FPS</label>
                        <select
                          value={config.target_fps}
                          onChange={(e) => setConfig({...config, target_fps: parseFloat(e.target.value)})}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        >
                          <option value={0.5}>0.5 FPS (1 frame every 2 seconds)</option>
                          <option value={1}>1 FPS (1 frame per second)</option>
                          <option value={2}>2 FPS (2 frames per second)</option>
                          <option value={3}>3 FPS (3 frames per second)</option>
                          <option value={5}>5 FPS (High density)</option>
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Requirements Info */}
              <div className="bg-gray-50 rounded-xl p-4">
                <h4 className="font-semibold text-gray-900 mb-2 flex items-center">
                  <Info className="h-5 w-5 mr-2" />
                  Processing Requirements
                </h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Minimum 10 images/frames required for 3D reconstruction</li>
                  <li>• Videos will be automatically converted to frames</li>
                  <li>• Higher quality = longer processing time (30s-30m)</li>
                  <li>• Best results with good lighting and multiple angles</li>
                  <li>• Estimated time: {getQualityInfo(config.quality_mode).time} for {config.quality_mode} quality</li>
                </ul>
              </div>
            </div>

            {uploading ? (
              <div className="space-y-3">
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-black h-2 rounded-full transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-sm text-gray-600 text-center">Uploading... {uploadProgress}%</p>
              </div>
            ) : (
              <div className="flex space-x-4 justify-center">
                <button
                  onClick={() => setFiles([])}
                  className="btn-secondary"
                >
                  Clear All
                </button>
                <button
                  onClick={handleUpload}
                  className="btn-primary"
                >
                  <Settings className="h-5 w-5 mr-2" />
                  Start Creating 3D Model
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 p-4 bg-red-50 rounded-lg flex items-center">
          <AlertCircle className="h-5 w-5 text-red-500 mr-2" />
          <p className="text-red-800">{error}</p>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded-lg shadow">
          <CheckCircle className="h-8 w-8 text-green-500 mb-2" />
          <h3 className="font-semibold text-gray-900">Step 1: Upload</h3>
          <p className="text-sm text-gray-600">Select your video or images</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <CheckCircle className="h-8 w-8 text-green-500 mb-2" />
          <h3 className="font-semibold text-gray-900">Step 2: Process</h3>
          <p className="text-sm text-gray-600">AI reconstructs 3D model</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <CheckCircle className="h-8 w-8 text-green-500 mb-2" />
          <h3 className="font-semibold text-gray-900">Step 3: View</h3>
          <p className="text-sm text-gray-600">Explore your 3D splat</p>
        </div>
      </div>
    </div>
  );
}
