'use client';

import { useState, useCallback } from 'react';
import { Upload, FileVideo, Image, CheckCircle, AlertCircle, Settings, Clock, Info, Zap, Sliders, Wrench } from 'lucide-react';
import { Accordion } from '@/components/ui';
import { api } from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function UploadPage() {
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const [uploadStartTime, setUploadStartTime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState({
    project_name: '',
    quality_mode: 'high',
    camera_model: 'SIMPLE_RADIAL',
    matcher_type: 'sequential',
    extraction_mode: 'fps',
    max_frames: 100,
    target_fps: 2.0,
    quality: 100,  // Legacy - kept for backward compatibility
    preview_count: 10,
    sfm_engine: 'glomap',  // 'colmap' or 'glomap' - default to GLOMAP for 10-100x faster reconstruction
    feature_method: 'sift',  // 'sift' (COLMAP), 'aliked' (hloc), 'superpoint' (hloc) - neural features are 10-20x faster
    use_gpu_extraction: true,  // GPU-accelerated video frame extraction (5-10x faster)
    mixed_precision: false,
    // New resolution-based extraction settings
    colmap_resolution: '2K',  // Resolution for COLMAP feature extraction (720p, 1080p, 2K, 4K, 8K, original)
    training_resolution: '4K',  // Resolution for 3DGS training (higher quality)
    use_separate_training_images: false,  // Extract separate high-res images for training
    // 8K Optimization
    crop_size: 0  // Patch-based training (0 = disabled)
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
    setUploadedBytes(0);
    setUploadSpeed(0);
    setUploadStartTime(Date.now());

    let lastLoaded = 0;
    let lastTime = Date.now();

    try {

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

      const result = await api.upload(files, uploadConfig, (loaded, total) => {
        // Update progress percentage
        const progress = Math.round((loaded / total) * 100);
        setUploadProgress(progress);
        setUploadedBytes(loaded);

        // Calculate upload speed (bytes per second)
        const now = Date.now();
        const timeDiff = (now - lastTime) / 1000; // seconds
        if (timeDiff > 0.5) { // Update speed every 0.5 seconds
          const bytesDiff = loaded - lastLoaded;
          const speed = bytesDiff / timeDiff;
          setUploadSpeed(speed);
          lastLoaded = loaded;
          lastTime = now;
        }
      });
      setUploadProgress(100);
      setUploadedBytes(totalSize);

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
      setUploadedBytes(0);
      setUploadSpeed(0);
      setUploadStartTime(null);
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
        className={`border-2 border-dashed rounded-2xl p-16 text-center transition-all ${isDragging
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
                    onChange={(e) => setConfig({ ...config, project_name: e.target.value })}
                    className="input"
                    placeholder="My Awesome 3D Model"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-black mb-2">Quality Preset</label>
                  <select
                    value={config.quality_mode}
                    onChange={(e) => setConfig({ ...config, quality_mode: e.target.value })}
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

              {/* Advanced Options Accordion */}
              <Accordion 
                title="Advanced Options" 
                icon={<Sliders className="h-5 w-5" />}
                badge="Optional"
                badgeColor="bg-blue-100 text-blue-700"
              >
                <div className="space-y-6">
                  {/* SfM Engine Selection */}
              <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl p-4 border border-green-200">
                <h4 className="font-semibold text-gray-900 mb-3 flex items-center">
                  <span className="text-xl mr-2">⚡</span>
                  Structure-from-Motion Engine
                </h4>
                <div className="grid md:grid-cols-1 gap-4">
                  <div>
                    <div className="flex gap-4">
                      <label className={`flex-1 p-4 rounded-xl border-2 cursor-pointer transition-all ${config.sfm_engine === 'glomap'
                        ? 'border-green-500 bg-green-100 shadow-md'
                        : 'border-gray-200 bg-white hover:border-green-300'
                        }`}>
                        <input
                          type="radio"
                          name="sfm_engine"
                          value="glomap"
                          checked={config.sfm_engine === 'glomap'}
                          onChange={(e) => setConfig({ ...config, sfm_engine: e.target.value })}
                          className="sr-only"
                        />
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-bold text-green-700 text-lg">🚀 GLOMAP</span>
                            <span className="ml-2 px-2 py-0.5 bg-green-500 text-white text-xs rounded-full">RECOMMENDED</span>
                          </div>
                          <span className="text-green-600 font-semibold">10-100x Faster</span>
                        </div>
                        <p className="text-sm text-gray-600 mt-2">
                          Global SfM - Processes all camera poses simultaneously.
                          <strong className="text-green-700"> Best for most datasets.</strong>
                        </p>
                        <p className="text-xs text-green-600 mt-1">✓ Same quality as COLMAP ✓ Much faster ✓ GPU accelerated</p>
                      </label>

                      <label className={`flex-1 p-4 rounded-xl border-2 cursor-pointer transition-all ${config.sfm_engine === 'fastmap'
                        ? 'border-purple-500 bg-purple-50 shadow-md'
                        : 'border-gray-200 bg-white hover:border-purple-300'
                        }`}>
                        <input
                          type="radio"
                          name="sfm_engine"
                          value="fastmap"
                          checked={config.sfm_engine === 'fastmap'}
                          onChange={(e) => setConfig({ ...config, sfm_engine: e.target.value })}
                          className="sr-only"
                        />
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-bold text-purple-700 text-lg">⚡ FastMap</span>
                            <span className="ml-2 px-2 py-0.5 bg-purple-500 text-white text-xs rounded-full">NEW</span>
                          </div>
                          <span className="text-purple-600 font-semibold">GPU-First</span>
                        </div>
                        <p className="text-sm text-gray-600 mt-2">
                          First-order SfM optimized for GPU.
                          <strong className="text-purple-700"> Best for video/dense scenes.</strong>
                        </p>
                        <p className="text-xs text-purple-600 mt-1">✓ GPU-native ✓ Dense coverage ⚠️ Less robust</p>
                      </label>

                      <label className={`flex-1 p-4 rounded-xl border-2 cursor-pointer transition-all ${config.sfm_engine === 'colmap'
                        ? 'border-blue-500 bg-blue-100 shadow-md'
                        : 'border-gray-200 bg-white hover:border-blue-300'
                        }`}>
                        <input
                          type="radio"
                          name="sfm_engine"
                          value="colmap"
                          checked={config.sfm_engine === 'colmap'}
                          onChange={(e) => setConfig({ ...config, sfm_engine: e.target.value })}
                          className="sr-only"
                        />
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-bold text-blue-700 text-lg">🔧 COLMAP</span>
                            <span className="ml-2 px-2 py-0.5 bg-gray-400 text-white text-xs rounded-full">CLASSIC</span>
                          </div>
                          <span className="text-gray-500 font-semibold">Standard Speed</span>
                        </div>
                        <p className="text-sm text-gray-600 mt-2">
                          Incremental SfM - Processes images one by one.
                          <strong className="text-blue-700"> Most mature &amp; stable.</strong>
                        </p>
                        <p className="text-xs text-blue-600 mt-1">✓ Battle-tested ✓ Handles edge cases ✓ More options</p>
                      </label>
                    </div>

                    {config.sfm_engine === 'fastmap' && (
                      <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                        <p className="text-sm text-yellow-800">
                          <strong>⚠️ FastMap Notice:</strong> Best for video frames with dense scene coverage. 
                          May fail on sparse photo collections or low-quality images. 
                          Use GLOMAP or COLMAP for more robust results.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

                  {/* Feature Extraction Method Selection */}
              <div className="bg-gradient-to-r from-cyan-50 to-teal-50 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold text-gray-900 flex items-center">
                    <span className="mr-2">🔬</span>
                    Feature Extraction Method
                    <span className="ml-2 text-xs bg-cyan-100 text-cyan-700 px-2 py-1 rounded-full">ULTRA SPEED</span>
                  </h4>
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  Neural features (ALIKED/SuperPoint) are <strong>10-20x faster</strong> than traditional SIFT for high-resolution images
                </p>
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-3">
                    <label className={`flex-1 min-w-[200px] p-4 rounded-xl border-2 cursor-pointer transition-all ${config.feature_method === 'aliked'
                      ? 'border-cyan-500 bg-cyan-50 shadow-lg shadow-cyan-100'
                      : 'border-gray-200 bg-white hover:border-cyan-300'}`}>
                      <div className="flex items-center">
                        <input
                          type="radio"
                          name="feature_method"
                          value="aliked"
                          checked={config.feature_method === 'aliked'}
                          onChange={(e) => setConfig({ ...config, feature_method: e.target.value })}
                          className="sr-only"
                        />
                        <div>
                          <span className="font-bold text-cyan-700 text-lg">⚡ ALIKED</span>
                          <span className="ml-2 text-xs bg-cyan-200 text-cyan-800 px-2 py-0.5 rounded">Fastest</span>
                          <p className="text-xs text-gray-500 mt-1">Neural features @ 125+ FPS</p>
                          <p className="text-xs text-cyan-600 mt-1">+ LightGlue matching (10-20x faster)</p>
                        </div>
                      </div>
                    </label>
                    <label className={`flex-1 min-w-[200px] p-4 rounded-xl border-2 cursor-pointer transition-all ${config.feature_method === 'superpoint'
                      ? 'border-indigo-500 bg-indigo-50 shadow-lg shadow-indigo-100'
                      : 'border-gray-200 bg-white hover:border-indigo-300'}`}>
                      <div className="flex items-center">
                        <input
                          type="radio"
                          name="feature_method"
                          value="superpoint"
                          checked={config.feature_method === 'superpoint'}
                          onChange={(e) => setConfig({ ...config, feature_method: e.target.value })}
                          className="sr-only"
                        />
                        <div>
                          <span className="font-bold text-indigo-700 text-lg">🎯 SuperPoint</span>
                          <span className="ml-2 text-xs bg-indigo-200 text-indigo-800 px-2 py-0.5 rounded">Best Quality</span>
                          <p className="text-xs text-gray-500 mt-1">Deep learning features @ 45 FPS</p>
                          <p className="text-xs text-indigo-600 mt-1">+ LightGlue matching (excellent accuracy)</p>
                        </div>
                      </div>
                    </label>
                    <label className={`flex-1 min-w-[200px] p-4 rounded-xl border-2 cursor-pointer transition-all ${config.feature_method === 'sift'
                      ? 'border-gray-500 bg-gray-50 shadow-lg shadow-gray-100'
                      : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                      <div className="flex items-center">
                        <input
                          type="radio"
                          name="feature_method"
                          value="sift"
                          checked={config.feature_method === 'sift'}
                          onChange={(e) => setConfig({ ...config, feature_method: e.target.value })}
                          className="sr-only"
                        />
                        <div>
                          <span className="font-bold text-gray-700 text-lg">📐 SIFT</span>
                          <span className="ml-2 text-xs bg-gray-200 text-gray-800 px-2 py-0.5 rounded">Classic</span>
                          <p className="text-xs text-gray-500 mt-1">Traditional COLMAP features</p>
                          <p className="text-xs text-gray-500 mt-1">Slower but most compatible</p>
                        </div>
                      </div>
                    </label>
                  </div>
                  {(config.feature_method === 'aliked' || config.feature_method === 'superpoint') && (
                    <div className="mt-3 p-3 bg-cyan-50 border border-cyan-200 rounded-lg">
                      <p className="text-sm text-cyan-800">
                        <strong>🚀 Neural Features:</strong> Using hloc with {config.feature_method === 'aliked' ? 'ALIKED' : 'SuperPoint'} + LightGlue. 
                        Dramatically faster for high-resolution images (4K/8K). Results are imported into COLMAP database for SfM reconstruction.
                      </p>
                    </div>
                  )}
                </div>
              </div>

                  {/* Resolution Settings */}
                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">COLMAP Resolution</label>
                      <select
                        value={config.colmap_resolution}
                        onChange={(e) => setConfig({ ...config, colmap_resolution: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value="720p">720p (1280x720) - Fast</option>
                        <option value="1080p">1080p (1920x1080) - Standard</option>
                        <option value="2K">2K (2560x1440) - Recommended</option>
                        <option value="4K">4K (3840x2160) - High Quality</option>
                        <option value="8K">8K (7680x4320) - Maximum</option>
                        <option value="original">Original Resolution</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Training Resolution</label>
                      <select
                        value={config.training_resolution}
                        onChange={(e) => setConfig({ ...config, training_resolution: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        <option value="1080p">1080p (1920x1080)</option>
                        <option value="2K">2K (2560x1440)</option>
                        <option value="4K">4K (3840x2160) - Recommended</option>
                        <option value="8K">8K (7680x4320) - Maximum</option>
                        <option value="original">Original Resolution</option>
                      </select>
                    </div>
                  </div>

                  {/* GPU Toggles */}
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="p-3 bg-gradient-to-r from-yellow-50 to-orange-50 rounded-lg border border-yellow-200">
                      <label className="flex items-center justify-between cursor-pointer">
                        <div className="flex items-center">
                          <Zap className="h-5 w-5 text-yellow-600 mr-2" />
                          <div>
                            <span className="font-medium text-gray-900">GPU Extraction</span>
                            <p className="text-xs text-gray-600">5-10x faster video decoding</p>
                          </div>
                        </div>
                        <div className="relative">
                          <input
                            type="checkbox"
                            checked={config.use_gpu_extraction}
                            onChange={(e) => setConfig({ ...config, use_gpu_extraction: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:bg-yellow-500 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                        </div>
                      </label>
                    </div>
                    <div className="p-3 bg-gradient-to-r from-yellow-50 to-orange-50 rounded-lg border border-yellow-200">
                      <label className="flex items-center justify-between cursor-pointer">
                        <div className="flex items-center">
                          <Zap className="h-5 w-5 text-yellow-600 mr-2" />
                          <div>
                            <span className="font-medium text-gray-900">Mixed Precision (FP16)</span>
                            <p className="text-xs text-gray-600">30-50% lower VRAM usage</p>
                          </div>
                        </div>
                        <div className="relative">
                          <input
                            type="checkbox"
                            checked={config.mixed_precision}
                            onChange={(e) => setConfig({ ...config, mixed_precision: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:bg-yellow-500 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* 8K Optimization - Patch Training */}
                  <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl p-4 border border-purple-200">
                    <h4 className="font-semibold text-gray-900 mb-3 flex items-center">
                      <span className="text-xl mr-2">🧩</span>
                      8K Optimization (Patch-based Training)
                    </h4>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Crop Size (pixels)</label>
                        <input
                          type="number"
                          value={config.crop_size}
                          onChange={(e) => setConfig({ ...config, crop_size: parseInt(e.target.value) || 0 })}
                          min="0"
                          max="2048"
                          step="64"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                          placeholder="0"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          0 = Use full image | 512-1024 = Recommended for 8K images
                        </p>
                      </div>
                      <div className="flex items-center">
                        <div className="bg-white rounded-lg p-3 border border-purple-100">
                          <p className="text-sm text-purple-800">
                            <strong>💡 Tip:</strong> ใช้ค่า 512 หรือ 1024 สำหรับภาพ 8K เพื่อลด VRAM
                          </p>
                          <p className="text-xs text-gray-600 mt-1">
                            ช่วยให้เทรนภาพความละเอียดสูงได้โดยไม่ต้องใช้ GPU ที่มี VRAM เยอะ
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                      {/* COLMAP Options */}
                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Feature Matching</label>
                      <select
                        value={config.matcher_type}
                        onChange={(e) => setConfig({ ...config, matcher_type: e.target.value })}
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
                        onChange={(e) => setConfig({ ...config, camera_model: e.target.value })}
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
                            onChange={(e) => setConfig({ ...config, extraction_mode: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          >
                            <option value="frames">Fixed Frame Count</option>
                            <option value="fps">Target FPS</option>
                          </select>
                        </div>
                        <div>
                          {config.extraction_mode === 'frames' ? (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Maximum Frames</label>
                              <select
                                value={config.max_frames}
                                onChange={(e) => setConfig({ ...config, max_frames: parseInt(e.target.value) })}
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
                                onChange={(e) => setConfig({ ...config, target_fps: parseFloat(e.target.value) })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                              >
                                <option value={0.5}>0.5 FPS (1 frame every 2 seconds)</option>
                                <option value={1}>1 FPS (1 frame per second)</option>
                                <option value={2}>2 FPS (2 frames per second)</option>
                                <option value={5}>5 FPS (5 frames per second)</option>
                                <option value={10}>10 FPS (High density)</option>
                                <option value={15}>15 FPS (Maximum density)</option>
                              </select>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 p-3 bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg border border-purple-200">
                        <label className="flex items-center justify-between cursor-pointer">
                          <div className="flex items-center">
                            <Image className="h-5 w-5 text-purple-600 mr-2" />
                            <div>
                              <span className="font-medium text-gray-900">Use High-Res Training Images</span>
                              <p className="text-xs text-gray-600">Extract separate higher resolution images for 3DGS training</p>
                            </div>
                          </div>
                          <div className="relative">
                            <input
                              type="checkbox"
                              checked={config.use_separate_training_images}
                              onChange={(e) => setConfig({ ...config, use_separate_training_images: e.target.checked })}
                              className="sr-only peer"
                            />
                            <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:bg-purple-500 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                          </div>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Expert Settings - Nested Accordion (only show when custom mode selected) */}
                  {config.quality_mode === 'custom' && (
                    <Accordion 
                      title="Expert Settings" 
                      icon={<Wrench className="h-5 w-5" />}
                      badge="Custom Parameters"
                      badgeColor="bg-purple-100 text-purple-700"
                    >
                      <div className="space-y-4">
                        {/* OpenSplat Training Parameters */}
                        <div className="border-b border-purple-200 pb-3">
                          <h5 className="text-sm font-semibold text-purple-900 mb-2">🎨 OpenSplat Training</h5>
                          <div className="grid md:grid-cols-2 gap-3">
                            <div title="จำนวนรอบการเทรน - มากขึ้น = คุณภาพดีขึ้น แต่ใช้เวลานานขึ้น">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Training Iterations
                              </label>
                              <input
                                type="number"
                                value={customParams.iterations}
                                onChange={(e) => setCustomParams({ ...customParams, iterations: parseInt(e.target.value) || 7000 })}
                                min="100"
                                max="50000"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Better quality but slower (7000)</p>
                            </div>
                            <div title="ค่าเกณฑ์การเพิ่ม Gaussian splats - ต่ำกว่า = splats หนาแน่นกว่า = รายละเอียดมากขึ้น">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Densify Grad Threshold
                              </label>
                              <input
                                type="number"
                                value={customParams.densify_grad_threshold}
                                onChange={(e) => setCustomParams({ ...customParams, densify_grad_threshold: parseFloat(e.target.value) || 0.00015 })}
                                min="0.00001"
                                max="0.001"
                                step="0.00001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Denser splats, more detail (0.00015)</p>
                            </div>
                            <div title="ความถี่การปรับแต่ง Gaussians - น้อยกว่า = ปรับบ่อยขึ้น = ละเอียดกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Refine Every (steps)
                              </label>
                              <input
                                type="number"
                                value={customParams.refine_every}
                                onChange={(e) => setCustomParams({ ...customParams, refine_every: parseInt(e.target.value) || 75 })}
                                min="10"
                                max="500"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More frequent refinement (75)</p>
                            </div>
                            <div title="ระยะ warmup ของ learning rate - ยาวขึ้น = training เสถียรกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Warmup Length
                              </label>
                              <input
                                type="number"
                                value={customParams.warmup_length}
                                onChange={(e) => setCustomParams({ ...customParams, warmup_length: parseInt(e.target.value) || 750 })}
                                min="100"
                                max="2000"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More stable training (750)</p>
                            </div>
                            <div title="น้ำหนักของ SSIM loss - สูงขึ้น = รักษาโครงสร้างได้ดีกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                SSIM Weight
                              </label>
                              <input
                                type="number"
                                value={customParams.ssim_weight}
                                onChange={(e) => setCustomParams({ ...customParams, ssim_weight: parseFloat(e.target.value) || 0.25 })}
                                min="0"
                                max="1"
                                step="0.01"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Better structure preservation (0.25)</p>
                            </div>
                          </div>
                        </div>

                        {/* OpenSplat Learning Rates */}
                        <div className="pt-2 border-b border-purple-200 pb-3">
                          <h5 className="text-sm font-semibold text-purple-900 mb-2">📊 OpenSplat Learning Rates</h5>
                          <div className="grid md:grid-cols-2 gap-3">
                            <div title="Main learning rate - ต่ำกว่า = training เสถียรกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Learning Rate
                              </label>
                              <input
                                type="number"
                                value={customParams.learning_rate}
                                onChange={(e) => setCustomParams({ ...customParams, learning_rate: parseFloat(e.target.value) || 0.0025 })}
                                min="0.0001"
                                max="0.01"
                                step="0.0001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More stable training (0.0025)</p>
                            </div>
                            <div title="Initial position learning rate">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Position LR Init
                              </label>
                              <input
                                type="number"
                                value={customParams.position_lr_init}
                                onChange={(e) => setCustomParams({ ...customParams, position_lr_init: parseFloat(e.target.value) || 0.00016 })}
                                min="0.00001"
                                max="0.001"
                                step="0.00001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Starting position LR (0.00016)</p>
                            </div>
                            <div title="Final position learning rate">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Position LR Final
                              </label>
                              <input
                                type="number"
                                value={customParams.position_lr_final}
                                onChange={(e) => setCustomParams({ ...customParams, position_lr_final: parseFloat(e.target.value) || 0.0000016 })}
                                min="0.0000001"
                                max="0.0001"
                                step="0.0000001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Ending position LR (0.0000016)</p>
                            </div>
                            <div title="Feature learning rate">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Feature LR
                              </label>
                              <input
                                type="number"
                                value={customParams.feature_lr}
                                onChange={(e) => setCustomParams({ ...customParams, feature_lr: parseFloat(e.target.value) || 0.0025 })}
                                min="0.0001"
                                max="0.01"
                                step="0.0001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Feature learning rate (0.0025)</p>
                            </div>
                            <div title="Opacity learning rate">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Opacity LR
                              </label>
                              <input
                                type="number"
                                value={customParams.opacity_lr}
                                onChange={(e) => setCustomParams({ ...customParams, opacity_lr: parseFloat(e.target.value) || 0.05 })}
                                min="0.001"
                                max="0.5"
                                step="0.001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Opacity LR (0.05)</p>
                            </div>
                            <div title="Scaling learning rate">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Scaling LR
                              </label>
                              <input
                                type="number"
                                value={customParams.scaling_lr}
                                onChange={(e) => setCustomParams({ ...customParams, scaling_lr: parseFloat(e.target.value) || 0.005 })}
                                min="0.0001"
                                max="0.05"
                                step="0.0001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Scaling LR (0.005)</p>
                            </div>
                            <div title="Rotation learning rate">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Rotation LR
                              </label>
                              <input
                                type="number"
                                value={customParams.rotation_lr}
                                onChange={(e) => setCustomParams({ ...customParams, rotation_lr: parseFloat(e.target.value) || 0.001 })}
                                min="0.0001"
                                max="0.01"
                                step="0.0001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Rotation LR (0.001)</p>
                            </div>
                            <div title="Percentage of dense points">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Percent Dense
                              </label>
                              <input
                                type="number"
                                value={customParams.percent_dense}
                                onChange={(e) => setCustomParams({ ...customParams, percent_dense: parseFloat(e.target.value) || 0.01 })}
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
                                Peak Threshold
                              </label>
                              <input
                                type="number"
                                value={customParams.peak_threshold}
                                onChange={(e) => setCustomParams({ ...customParams, peak_threshold: parseFloat(e.target.value) || 0.01 })}
                                min="0.001"
                                max="0.1"
                                step="0.001"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More robust features (0.01)</p>
                            </div>
                            <div title="SIFT edge threshold - สูงขึ้น = กรอง false edges ได้ดีกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Edge Threshold
                              </label>
                              <input
                                type="number"
                                value={customParams.edge_threshold}
                                onChange={(e) => setCustomParams({ ...customParams, edge_threshold: parseFloat(e.target.value) || 15 })}
                                min="5"
                                max="30"
                                step="1"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Reduce false edges (15)</p>
                            </div>
                            <div title="จำนวน orientations ต่อ keypoint - มากขึ้น = รับรู้ได้หลากหลายกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Max Num Orientations
                              </label>
                              <input
                                type="number"
                                value={customParams.max_num_orientations}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_orientations: parseInt(e.target.value) || 2 })}
                                min="1"
                                max="5"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More orientation variety (2)</p>
                            </div>
                          </div>
                        </div>

                        {/* COLMAP Feature Extraction & Matching */}
                        <div className="pt-2 border-b border-purple-200 pb-3">
                          <h5 className="text-sm font-semibold text-purple-900 mb-2">🔍 COLMAP Feature Extraction & Matching</h5>
                          <div className="grid md:grid-cols-2 gap-3">
                            <div title="จำนวน SIFT features สูงสุดต่อภาพ - มากขึ้น = ดึงรายละเอียดได้มากขึ้น = จับคู่ได้ดีขึ้น">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Max Features per Image
                              </label>
                              <input
                                type="number"
                                value={customParams.max_num_features}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_features: parseInt(e.target.value) || 12288 })}
                                min="1024"
                                max="32768"
                                step="1024"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More feature points = Better coverage (12288)</p>
                            </div>
                            <div title="จำนวน match points สูงสุดต่อ image pair - มากขึ้น = การจับคู่แม่นยำกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Max Matches per Pair
                              </label>
                              <input
                                type="number"
                                value={customParams.max_num_matches}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_matches: parseInt(e.target.value) || 32768 })}
                                min="4096"
                                max="65536"
                                step="4096"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More accurate matching (32768)</p>
                            </div>
                            <div title="จำนวนภาพที่แต่ละภาพจะจับคู่ด้วย - มากขึ้น = connectivity ดีกว่า">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Sequential Overlap
                              </label>
                              <input
                                type="number"
                                value={customParams.sequential_overlap}
                                onChange={(e) => setCustomParams({ ...customParams, sequential_overlap: parseInt(e.target.value) || 18 })}
                                min="5"
                                max="50"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Better image connectivity (18)</p>
                            </div>
                          </div>
                        </div>

                        {/* COLMAP Mapper (Reconstruction) */}
                        <div className="pt-2">
                          <h5 className="text-sm font-semibold text-purple-900 mb-2">🏗️ COLMAP Sparse Reconstruction (Mapper)</h5>
                          <div className="grid md:grid-cols-2 gap-3">
                            <div title="จำนวน matches ขั้นต่ำที่ยอมรับ - น้อยกว่า = ยอมรับภาพที่ match ยากขึ้น = register ได้มากขึ้น">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Min Num Matches
                              </label>
                              <input
                                type="number"
                                value={customParams.min_num_matches}
                                onChange={(e) => setCustomParams({ ...customParams, min_num_matches: parseInt(e.target.value) || 16 })}
                                min="6"
                                max="50"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Accept weaker matches = More images registered (16)</p>
                            </div>
                            <div title="จำนวนโมเดลสูงสุดที่ลองสร้าง - มากขึ้น = โอกาสได้โมเดลที่ดีสูงขึ้น">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Max Num Models
                              </label>
                              <input
                                type="number"
                                value={customParams.max_num_models}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_models: parseInt(e.target.value) || 40 })}
                                min="5"
                                max="100"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Try more models = Higher chance of good result (40)</p>
                            </div>
                            <div title="จำนวนครั้งที่ลอง initialize reconstruction - มากขึ้น = โอกาสสำเร็จสูงขึ้น">
                              <label className="block text-xs font-medium text-gray-700 mb-1 cursor-help">
                                Init Num Trials
                              </label>
                              <input
                                type="number"
                                value={customParams.init_num_trials}
                                onChange={(e) => setCustomParams({ ...customParams, init_num_trials: parseInt(e.target.value) || 225 })}
                                min="50"
                                max="500"
                                className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More init attempts = Higher success rate (225)</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </Accordion>
                  )}
                </div>
              </Accordion>

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
                <div className="w-full bg-gray-100 rounded-full h-3">
                  <div
                    className="bg-gradient-to-r from-blue-500 to-blue-600 h-3 rounded-full transition-all duration-300 relative"
                    style={{ width: `${uploadProgress}%` }}
                  >
                    {uploadProgress > 5 && (
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white">
                        {uploadProgress}%
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex justify-between items-center text-sm text-gray-600">
                  <span>
                    📤 {formatFileSize(uploadedBytes)} / {formatFileSize(totalSize)}
                  </span>
                  <span>
                    {uploadSpeed > 0 ? `⚡ ${formatFileSize(uploadSpeed)}/s` : '⏳ Starting...'}
                  </span>
                </div>
                <p className="text-xs text-gray-500 text-center">
                  {uploadProgress < 100
                    ? uploadSpeed > 0
                      ? `Estimated time: ~${Math.ceil((totalSize - uploadedBytes) / uploadSpeed)}s remaining`
                      : 'Calculating speed...'
                    : '✅ Upload complete! Processing will start automatically...'
                  }
                </p>
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
