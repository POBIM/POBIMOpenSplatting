'use client';

import { useState, useCallback, useEffect } from 'react';
import { Upload, FileVideo, Image, CheckCircle, AlertCircle, Settings, Info, Zap, Sliders, Wrench } from 'lucide-react';
import { Accordion } from '@/components/ui';
import { api, UploadPolicyPreview } from '@/lib/api';
import { getMatcherLabelWithMode, getSfmEngineCompactLabel, getSfmEngineLabel } from '@/lib/sfm-display';
import { useRouter } from 'next/navigation';

type MatcherMode = 'auto' | 'sequential' | 'exhaustive' | 'vocab_tree';
type SfmBackendMode = 'cli' | 'pycolmap';

export default function UploadPage() {
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [policyPreview, setPolicyPreview] = useState<UploadPolicyPreview | null>(null);
  const [policyPreviewLoading, setPolicyPreviewLoading] = useState(false);
  const [config, setConfig] = useState({
    project_name: '',
    quality_mode: 'hard',
    camera_model: 'SIMPLE_RADIAL',
    matcher_type: 'auto' as MatcherMode,
    extraction_mode: 'fps',
    max_frames: 100,
    target_fps: 2.0,
    quality: 100,  // Legacy - kept for backward compatibility
    preview_count: 10,
    smart_frame_selection: true,
    oversample_factor: 10,
    replacement_search_radius: 4,
    ffmpeg_cpu_workers: 4,
    sfm_engine: 'colmap',
    sfm_backend: 'cli' as SfmBackendMode,
    force_cpu_sparse_reconstruction: true,
    feature_method: 'sift',  // 'sift' (classic COLMAP), 'aliked' (native COLMAP neural), 'superpoint' (hloc)
    use_gpu_extraction: true,  // GPU-accelerated video frame extraction (5-10x faster)
    mixed_precision: false,
    // New resolution-based extraction settings
    colmap_resolution: '2K',  // Resolution for COLMAP feature extraction (720p, 1080p, 2K, 4K, 8K, original)
    training_resolution: '4K',  // Resolution for 3DGS training (higher quality)
    use_separate_training_images: false,  // Extract separate high-res images for training
    // 8K Optimization
    crop_size: 0  // Patch-based training (0 = disabled)
  });
  const usesGlobalSfm = config.sfm_engine === 'glomap';

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

  const handleFileSelect = useCallback((selectedFiles: File[]) => {
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
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      handleFileSelect(droppedFiles);
    }
  }, [handleFileSelect]);

  const handleUpload = async () => {
    if (files.length === 0) return;

    setUploading(true);
    setError(null);
    setUploadProgress(0);
    setUploadedBytes(0);
    setUploadSpeed(0);

    let lastLoaded = 0;
    let lastTime = Date.now();

    try {

      // Add custom parameters to config if custom mode is selected
      const uploadConfig = {
        ...config,
        matcher_type: config.matcher_type === 'auto' ? undefined : config.matcher_type,
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
  const inputProfile = hasVideo && hasImages ? 'mixed' : hasVideo ? 'video' : hasImages ? 'images' : 'unknown';
  const estimatedSearchWindow =
    config.extraction_mode === 'fps' && config.target_fps > 0
      ? `up to ±${Math.max(config.replacement_search_radius, Math.round(30 / config.target_fps))} frames`
      : `at least ±${config.replacement_search_radius} frames`;
  const estimatedCandidatePool =
    config.extraction_mode === 'fps'
      ? `${config.target_fps * config.oversample_factor} FPS candidate pass`
      : `${config.max_frames * config.oversample_factor} candidates before pruning`;
  const largeImageSet = inputProfile === 'images' && files.length >= 300;
  const matcherRecommendation = hasVideo
    ? 'Auto is recommended for video and orbit captures. Sequential matching usually fits ordered frames best, Global SfM is the safer fallback for harder cases, and Exhaustive is only worth forcing when you want maximum pair coverage.'
    : hasImages && !hasVideo
      ? largeImageSet
        ? 'Auto is recommended for most photo sets. The backend can choose Exhaustive for smaller unordered groups, Vocabulary Tree as an experimental option for larger unordered collections, and Sequential only when the capture order is meaningful.'
        : 'Auto is recommended for most photo sets. The backend can choose Exhaustive for smaller unordered image collections, Vocabulary Tree as an experimental option for larger unordered collections, and Sequential only when the input looks ordered.'
      : 'Auto lets the backend pick a matcher after inspecting the uploaded media.';
  const engineRecommendation = hasVideo
    ? 'For ordered video/orbit captures, COLMAP Incremental is the conservative choice, COLMAP Global SfM can still work when the pair graph is strong, and FastMap stays the speed-first option for dense GPU-friendly inputs.'
    : 'For unordered photo sets, COLMAP Global SfM is usually the best starting point. COLMAP Incremental is safer when you want step-by-step recovery, and FastMap is the GPU-first option when speed matters more than robustness.';
  const policyLegend = [
    {
      key: 'video',
      label: 'Video / orbit',
      detail: 'Emerald policy for ordered frames and orbit-safe behavior.',
      dotClass: 'bg-emerald-500',
      toneClass: 'border-emerald-200 bg-emerald-50 text-emerald-900',
      icon: FileVideo,
    },
    {
      key: 'mixed',
      label: 'Mixed capture',
      detail: 'Amber policy for cautious inspection before lock-in.',
      dotClass: 'bg-amber-500',
      toneClass: 'border-amber-200 bg-amber-50 text-amber-900',
      icon: Upload,
    },
    {
      key: 'images',
      label: 'Image set',
      detail: 'Sky policy for photo collections and unordered coverage.',
      dotClass: 'bg-sky-500',
      toneClass: 'border-sky-200 bg-sky-50 text-sky-900',
      icon: Image,
    },
  ] as const;
  const expectedPolicy = (() => {
    if (inputProfile === 'video') {
      return {
        title: 'Orbit-Safe Video Policy',
        tone: 'border-emerald-200 bg-emerald-50 text-emerald-900',
        badgeTone: 'border-emerald-200 bg-emerald-100 text-emerald-900',
        profileBadge: 'video orbit',
        matcherBadge: config.matcher_type === 'auto' ? 'auto -> sequential' : getMatcherLabelWithMode(config.matcher_type),
        engineBadge: `${getSfmEngineCompactLabel(config.sfm_engine)} preferred`,
        summary: 'Ordered frames usually start with Sequential matching. Global SfM can still be used as a fallback, while FastMap is the speed-first option for dense GPU-oriented inputs.',
        icon: FileVideo,
      };
    }

    if (inputProfile === 'mixed') {
      return {
        title: 'Mixed Capture Policy',
        tone: 'border-amber-200 bg-amber-50 text-amber-900',
        badgeTone: 'border-amber-200 bg-amber-100 text-amber-900',
        profileBadge: 'mixed input',
        matcherBadge: config.matcher_type === 'auto' ? 'auto -> inspect ordering' : getMatcherLabelWithMode(config.matcher_type),
        engineBadge: `${getSfmEngineCompactLabel(config.sfm_engine)} preferred`,
        summary: 'Mixed uploads are treated cautiously. The backend inspects whether the set behaves more like ordered frames or unordered photos before choosing between Sequential, Exhaustive, Vocabulary Tree, or a safer mapper fallback.',
        icon: Upload,
      };
    }

    if (inputProfile === 'images') {
      return {
        title: 'Photo Set Policy',
        tone: 'border-sky-200 bg-sky-50 text-sky-900',
        badgeTone: 'border-sky-200 bg-sky-100 text-sky-900',
        profileBadge: 'image collection',
        matcherBadge: config.matcher_type === 'auto' ? (largeImageSet ? 'auto -> exhaustive / vocab tree' : 'auto -> exhaustive or sequential') : getMatcherLabelWithMode(config.matcher_type),
        engineBadge: `${getSfmEngineCompactLabel(config.sfm_engine)} preferred`,
        summary: largeImageSet
          ? 'For photo collections, the backend usually prefers Exhaustive on smaller unordered sets, Vocabulary Tree as an experimental scale-up option for larger unordered collections, and Sequential only when filenames or capture order look strongly ordered.'
          : 'For photo collections, the backend usually prefers Exhaustive on smaller unordered sets, Vocabulary Tree as an experimental scale-up option for larger unordered collections, and Sequential only when filenames or capture order look strongly ordered.',
        icon: Image,
      };
    }

    return {
      title: 'Waiting For Media Signal',
      tone: 'border-gray-200 bg-gray-50 text-gray-800',
      badgeTone: 'border-gray-200 bg-white text-gray-700',
      profileBadge: 'no files yet',
      matcherBadge: config.matcher_type === 'auto' ? 'auto' : getMatcherLabelWithMode(config.matcher_type),
      engineBadge: `${getSfmEngineCompactLabel(config.sfm_engine)} preferred`,
      summary: 'Select files first, then this panel will estimate which reconstruction policy the backend is most likely to apply.',
      icon: Info,
    };
  })();
  const confidenceAssessment = (() => {
    let score = inputProfile === 'video' ? 88 : inputProfile === 'images' ? 76 : inputProfile === 'mixed' ? 68 : 42;
    const reasons: string[] = [];

    if (config.matcher_type !== 'auto') {
      score -= 18;
      reasons.push(`matcher override: ${getMatcherLabelWithMode(config.matcher_type)}`);
    } else {
      reasons.push('matcher auto enabled');
    }

    if (inputProfile === 'images' && config.sfm_engine === 'fastmap') {
      score -= 20;
      reasons.push('fastmap on image-only set');
    }

    if (inputProfile === 'mixed' && config.sfm_engine === 'fastmap') {
      score -= 14;
      reasons.push('fastmap on mixed input');
    }

    if (inputProfile === 'video' && config.matcher_type === 'exhaustive') {
      score -= 16;
      reasons.push('exhaustive override on video');
    }

    if (inputProfile === 'images' && config.matcher_type === 'sequential') {
      score -= 14;
      reasons.push('sequential override on photos');
    }

    if (config.matcher_type === 'vocab_tree') {
      score -= 4;
      reasons.push('experimental vocab tree matcher');
    }

    if (hasVideo && config.extraction_mode === 'fps') {
      if (config.target_fps >= 10) {
        score -= 8;
        reasons.push(`dense sampling at ${config.target_fps} fps`);
      } else if (config.target_fps >= 2 && config.target_fps <= 5) {
        score += 4;
        reasons.push(`balanced sampling at ${config.target_fps} fps`);
      } else if (config.target_fps < 1) {
        score -= 6;
        reasons.push(`sparse sampling at ${config.target_fps} fps`);
      }
    }

    if (hasVideo && (config.extraction_mode === 'frames' || config.extraction_mode === 'target_count')) {
      if (config.max_frames >= 400) {
        score -= 7;
        reasons.push(`high frame count: ${config.max_frames}`);
      } else if (config.max_frames >= 100 && config.max_frames <= 250) {
        score += 3;
        reasons.push(`balanced frame count: ${config.max_frames}`);
      } else if (config.max_frames < 80) {
        score -= 5;
        reasons.push(`limited frame count: ${config.max_frames}`);
      }
    }

    if ((inputProfile === 'images' || inputProfile === 'mixed') && config.feature_method !== 'sift') {
      score += 5;
      reasons.push(`neural features: ${config.feature_method}`);
    }

    if (inputProfile === 'video' && config.feature_method === 'sift') {
      score += 2;
      reasons.push('classic sift compatibility for video');
    }

    if (hasVideo && config.use_separate_training_images) {
      score += 2;
      reasons.push('separate training images enabled');
    }

    score = Math.max(18, Math.min(96, score));

    if (score >= 80) {
      return {
        label: 'High',
        tone: 'border-emerald-200 bg-emerald-100 text-emerald-900',
        meterClass: 'bg-emerald-500',
        score,
        reasons,
      };
    }

    if (score >= 60) {
      return {
        label: 'Medium',
        tone: 'border-amber-200 bg-amber-100 text-amber-900',
        meterClass: 'bg-amber-500',
        score,
        reasons,
      };
    }

    return {
      label: 'Cautious',
      tone: 'border-rose-200 bg-rose-100 text-rose-900',
      meterClass: 'bg-rose-500',
      score,
      reasons,
    };
  })();
  const previewRules = (() => {
    const rules: Array<{ level: 'info' | 'warning'; text: string }> = [];

    if (config.matcher_type !== 'auto') {
      rules.push({
        level: 'warning',
        text: `Matcher override is active. The backend will respect ${getMatcherLabelWithMode(config.matcher_type)} instead of choosing automatically.`,
      });
    } else {
      rules.push({
        level: 'info',
        text: 'Matcher is on Auto, so the backend can still adapt from capture ordering and pair geometry.',
      });
    }

    if (config.matcher_type === 'vocab_tree') {
      rules.push({
        level: 'info',
        text: 'Vocabulary Tree is an experimental matcher that can help larger unordered photo collections. Use it when Exhaustive starts getting too expensive.',
      });
    }

    if (inputProfile === 'images' && config.sfm_engine === 'fastmap') {
      rules.push({
        level: 'warning',
        text: 'FastMap with an image-only set is a riskier combination. COLMAP Global SfM or COLMAP Incremental is usually safer for unordered photo collections.',
      });
    }

    if (inputProfile === 'video' && config.matcher_type === 'exhaustive') {
      rules.push({
        level: 'warning',
        text: 'Exhaustive matching on video/orbit input may reduce the benefit of orbit-safe sequential policy.',
      });
    }

    if (inputProfile === 'images' && config.matcher_type === 'sequential') {
      rules.push({
        level: 'warning',
        text: 'Sequential override assumes the filenames or capture order are meaningful. Use Auto or Exhaustive for unordered photos.',
      });
    }

    if (inputProfile === 'mixed' && config.sfm_engine === 'fastmap') {
      rules.push({
        level: 'warning',
        text: 'FastMap on mixed media can be brittle when some inputs behave like unordered photos.',
      });
    }

    if (inputProfile === 'video' && config.sfm_engine === 'colmap') {
      rules.push({
        level: 'info',
        text: 'COLMAP Incremental is a conservative choice for video input and aligns well with stricter orbit-safe reconstruction.',
      });
    }

    if (hasVideo && config.extraction_mode === 'fps' && config.target_fps >= 10) {
      rules.push({
        level: 'warning',
        text: `Target FPS is set to ${config.target_fps}. Very dense sampling can add near-duplicate frames and reduce policy confidence.`,
      });
    }

    if (hasVideo && config.extraction_mode === 'fps' && config.target_fps > 0 && config.target_fps < 1) {
      rules.push({
        level: 'warning',
        text: `Target FPS is ${config.target_fps}. Sparse sampling may weaken bridge geometry across the orbit.`,
      });
    }

    if (hasVideo && (config.extraction_mode === 'frames' || config.extraction_mode === 'target_count') && config.max_frames >= 400) {
      rules.push({
        level: 'warning',
        text: `Maximum frames is ${config.max_frames}. This is dense enough to create redundancy and heavier matching load.`,
      });
    }

    if (hasVideo && (config.extraction_mode === 'frames' || config.extraction_mode === 'target_count') && config.max_frames < 80) {
      rules.push({
        level: 'warning',
        text: `Maximum frames is only ${config.max_frames}. Sparse frame coverage may make loop closure and bridge recovery harder.`,
      });
    }

    if ((inputProfile === 'images' || inputProfile === 'mixed') && config.feature_method !== 'sift') {
      rules.push({
        level: 'info',
        text: `${config.feature_method} + LightGlue should help high-resolution photo coverage and usually raises preview confidence for photo-heavy inputs.`,
      });
    }

    if (inputProfile === 'video' && config.feature_method !== 'sift') {
      rules.push({
        level: 'info',
        text: `${config.feature_method} is enabled. Neural features can speed up matching, but ordered video policy still matters more than raw descriptor choice.`,
      });
    }

    if (hasVideo && config.use_separate_training_images) {
      rules.push({
        level: 'info',
        text: 'Separate high-resolution training images are enabled. This improves training quality but does not change the sparse policy directly.',
      });
    }

    return rules;
  })();
  const resolvedInputProfile = policyPreview?.input_profile ?? inputProfile;
  const resolvedExpectedPolicy = policyPreview?.expected_policy ?? expectedPolicy;
  const resolvedConfidence = policyPreview?.confidence ?? confidenceAssessment;
  const resolvedPreviewRules = policyPreview?.preview_rules ?? previewRules;
  const resolvedConfidenceSignals = policyPreview?.confidence?.signals
    ?? confidenceAssessment.reasons.map((reason, index) => ({
      key: `fallback-${index}`,
      label: reason,
      delta: 0,
      detail: reason,
    }));
  const resolvedEstimatedNumImages = policyPreview?.estimated_num_images;
  const policyToneKey = policyPreview?.expected_policy?.toneKey ?? resolvedInputProfile;
  const PolicyIcon = policyToneKey === 'video'
    ? FileVideo
    : policyToneKey === 'mixed'
      ? Upload
      : policyToneKey === 'images'
        ? Image
        : Info;

  useEffect(() => {
    if (config.sfm_engine !== 'glomap' && config.sfm_backend !== 'cli') {
      setConfig((current) => ({ ...current, sfm_backend: 'cli' }));
    }
  }, [config.sfm_engine, config.sfm_backend]);

  useEffect(() => {
    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        setPolicyPreviewLoading(true);
        const preview = await api.previewUploadPolicy(files, {
          ...config,
          matcher_type: config.matcher_type === 'auto' ? undefined : config.matcher_type,
        });
        if (!cancelled) {
          setPolicyPreview(preview);
        }
      } catch (previewError) {
        if (!cancelled) {
          setPolicyPreview(null);
          console.error('Failed to load backend upload policy preview:', previewError);
        }
      } finally {
        if (!cancelled) {
          setPolicyPreviewLoading(false);
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [files, config]);

  const getQualityInfo = (mode: string) => {
    const info = {
      fast: { iterations: 500, time: '~30s-2m', desc: 'Quick preview' },
      balanced: { iterations: 7000, time: '~5-15m', desc: 'High quality (NEW default)' },
      hard: { iterations: 5000, time: '~6-18m', desc: 'Coverage-first COLMAP pass, tuned for later retry' },
      high: { iterations: 7000, time: '~5-15m', desc: 'High detail' },
      ultra: { iterations: 15000, time: '~10-30m', desc: 'Maximum quality' },
      professional: { iterations: 30000, time: '~20-60m', desc: 'Professional grade for 4K+ images' },
      ultra_professional: { iterations: 60000, time: '~40-90m', desc: 'Ultra professional grade for highest quality' },
      robust: { iterations: 7000, time: '~5-15m', desc: 'For difficult images' }
    };
    return info[mode as keyof typeof info] || info.balanced;
  };

  const qualityInfo = getQualityInfo(config.quality_mode);
  const minimumFilesReached = files.length >= 10;
  const wizardSteps = [
    {
      key: 'media',
      href: '#stage-media',
      label: 'Media',
      detail: files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'Add files',
      icon: Upload,
      status: files.length > 0 ? 'complete' : 'current',
    },
    {
      key: 'setup',
      href: '#stage-setup',
      label: 'Setup',
      detail: config.project_name || 'Name + preset',
      icon: Settings,
      status: files.length > 0 && !uploading ? 'current' : files.length > 0 ? 'complete' : 'upcoming',
    },
    {
      key: 'pipeline',
      href: '#stage-pipeline',
      label: 'Pipeline',
      detail: `${getSfmEngineCompactLabel(config.sfm_engine)} • ${config.feature_method}`,
      icon: Sliders,
      status: files.length > 0 ? 'current' : 'upcoming',
    },
    {
      key: 'launch',
      href: '#stage-launch',
      label: 'Launch',
      detail: uploading ? `${uploadProgress}% uploading` : 'Start processing',
      icon: CheckCircle,
      status: uploading ? 'current' : files.length > 0 ? 'upcoming' : 'upcoming',
    },
  ] as const;

  return (
    <div className="brutal-shell">
      <section className="brutal-section">
        <div className="brutal-container max-w-7xl space-y-6">
          <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
              <div className="brutal-card-dark p-4">
                <span className="brutal-eyebrow -rotate-1 text-[color:var(--text-on-ink-muted)]">Upload Wizard</span>
                <h1 className="brutal-h2 mt-3 text-[color:var(--text-on-ink)]">Build your dataset in stages</h1>
                <p className="mt-2 text-sm font-medium text-[color:var(--text-on-ink-muted)]">
                  อ่านทีละขั้นตอน เลือกเฉพาะที่จำเป็น และเปิดรายละเอียดเพิ่มเมื่อจำเป็นเท่านั้น
                </p>
              </div>

              <nav className="brutal-card p-3">
                <div className="space-y-2">
                  {wizardSteps.map((step, index) => {
                    const StepIcon = step.icon;
                    const isCurrent = step.status === 'current';
                    const isComplete = step.status === 'complete';

                    return (
                      <a
                        key={step.key}
                        href={step.href}
                        className={`flex items-center gap-3 border p-3 transition-transform hover:-translate-y-0.5 ${
                          isCurrent
                            ? 'bg-[color:var(--ink)] text-[color:var(--text-on-ink)]'
                            : isComplete
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                              : 'bg-[color:var(--paper-muted)] text-[color:var(--text-secondary)]'
                        }`}
                      >
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center border ${
                          isCurrent
                            ? 'border-[color:var(--text-on-ink)] bg-[color:var(--paper-card)] text-[color:var(--ink)]'
                            : isComplete
                              ? 'border-emerald-300 bg-white text-emerald-700'
                              : 'border-[color:var(--ink)] bg-white text-[color:var(--ink)]'
                        }`}>
                          <StepIcon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-black uppercase tracking-wide">0{index + 1}</p>
                            {isComplete ? <CheckCircle className="h-4 w-4" /> : null}
                          </div>
                          <p className="mt-1 text-sm font-bold">{step.label}</p>
                          <p className="truncate text-xs opacity-80">{step.detail}</p>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </nav>

              <div className="brutal-card-muted p-4">
                <p className="brutal-label">Quick Signal</p>
                <div className="mt-3 grid gap-3">
                  <div className="flex items-center justify-between text-sm font-semibold text-[color:var(--ink)]">
                    <span className="flex items-center gap-2">
                      <PolicyIcon className="h-4 w-4" />
                      Detected profile
                    </span>
                    <span className="uppercase">{resolvedInputProfile}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm font-semibold text-[color:var(--ink)]">
                    <span className="flex items-center gap-2">
                      <Sliders className="h-4 w-4" />
                      Preview confidence
                    </span>
                    <span>{resolvedConfidence.score}/100</span>
                  </div>
                  <div className="flex items-center justify-between text-sm font-semibold text-[color:var(--ink)]">
                    <span className="flex items-center gap-2">
                      <Settings className="h-4 w-4" />
                      Time estimate
                    </span>
                    <span>{qualityInfo.time}</span>
                  </div>
                </div>
              </div>
            </aside>

            <div className="space-y-6">
              {error && (
                <div className="flex items-center gap-2 border border-[color:var(--ink)] p-3" style={{ background: 'var(--error-bg)', color: 'var(--error-text)', boxShadow: 'var(--shadow-sm)' }}>
                  <AlertCircle className="h-5 w-5" />
                  <p className="text-sm font-bold">{error}</p>
                </div>
              )}

              <section id="stage-media" className="brutal-card overflow-hidden">
                <div className="border-b border-[color:var(--ink)] bg-[color:var(--paper-muted)] p-4 md:p-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="brutal-eyebrow rotate-1">Stage 01</p>
                      <h2 className="brutal-h2 mt-2">เลือกไฟล์</h2>
                      <p className="mt-2 text-sm font-medium text-[color:var(--text-secondary)]">
                        เริ่มจากโยนไฟล์เข้ามา ระบบจะเดา profile และ policy ให้ทันที
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-bold uppercase tracking-wide">
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">MP4</span>
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">MOV</span>
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">JPG</span>
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">PNG / WebP / TIFF</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-4 p-4 md:p-5">
                  <div
                    className={`relative overflow-hidden border-2 border-dashed p-6 text-center transition-all md:p-10 ${
                      isDragging
                        ? 'border-[color:var(--ink)] bg-[color:var(--paper-muted)] shadow-[var(--shadow-md)]'
                        : 'border-[color:var(--ink)] bg-[color:var(--paper-card)] shadow-[var(--shadow-sm)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]'
                    }`}
                  >
                    <label
                      htmlFor="file-input"
                      className="block cursor-pointer"
                      onDragEnter={handleDragEnter}
                      onDragLeave={handleDragLeave}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                    >
                      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center border border-[color:var(--ink)] bg-[color:var(--paper-muted)] shadow-[var(--shadow-sm)]">
                        <Upload className="h-8 w-8 text-[color:var(--ink)]" />
                      </div>
                      <p className="brutal-h2 mb-2">{files.length === 0 ? 'ลากไฟล์มาวาง หรือกดเพื่อเลือก' : 'เพิ่มไฟล์ได้อีกตลอด'}</p>
                      <p className="mx-auto mb-6 max-w-xl text-sm font-medium text-[color:var(--text-secondary)]">
                        จำกัดขนาดไฟล์ละ 5GB และรองรับทั้งวิดีโอหรือชุดภาพ
                      </p>
                      <input
                        type="file"
                        accept="video/*,image/*"
                        multiple
                        onChange={(e) => e.target.files && handleFileSelect(Array.from(e.target.files))}
                        className="hidden"
                        id="file-input"
                      />
                      <span className="brutal-btn brutal-btn-primary">Choose Files</span>
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="brutal-card-muted p-4">
                      <div className="flex items-center gap-2">
                        <Upload className="h-4 w-4" />
                        <p className="brutal-label">Total files</p>
                      </div>
                      <p className="mt-2 text-2xl font-black text-[color:var(--ink)]">{files.length}</p>
                    </div>
                    <div className="brutal-card-muted p-4">
                      <div className="flex items-center gap-2">
                        <PolicyIcon className="h-4 w-4" />
                        <p className="brutal-label">Input profile</p>
                      </div>
                      <p className="mt-2 text-2xl font-black uppercase text-[color:var(--ink)]">{resolvedInputProfile}</p>
                    </div>
                    <div className="brutal-card-muted p-4">
                      <div className="flex items-center gap-2">
                        <Info className="h-4 w-4" />
                        <p className="brutal-label">Total size</p>
                      </div>
                      <p className="mt-2 text-2xl font-black text-[color:var(--ink)]">{formatFileSize(totalSize)}</p>
                    </div>
                  </div>

                  {files.length > 0 && (
                    <div className="brutal-card-muted p-4 text-left">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="brutal-h3">Selected Files</h3>
                        <span className="brutal-badge -rotate-1">{files.length}</span>
                      </div>
                      <div className="brutal-scroll mt-4 max-h-64 space-y-2 overflow-y-auto pr-1">
                        {files.map((file, index) => (
                          <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between border border-[color:var(--ink)] bg-[color:var(--paper-card)] p-3">
                            <div className="flex min-w-0 items-center gap-3">
                              {file.type.startsWith('video/') ? (
                                <FileVideo className="h-4 w-4 shrink-0 text-[color:var(--ink)]" />
                              ) : (
                                <Image className="h-4 w-4 shrink-0 text-[color:var(--ink)]" />
                              )}
                              <div className="min-w-0">
                                <p className="truncate text-sm font-black uppercase tracking-tight text-[color:var(--ink)]">{file.name}</p>
                                <p className="text-xs font-medium text-[color:var(--text-secondary)]">
                                  {formatFileSize(file.size)} • {file.type.startsWith('video/') ? 'Video' : 'Image'}
                                </p>
                              </div>
                            </div>
                            <button type="button" onClick={() => removeFile(index)} className="brutal-btn brutal-btn-xs" title="Remove file">
                              <AlertCircle className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section id="stage-setup" className="brutal-card overflow-hidden">
                <div className="border-b border-[color:var(--ink)] bg-[color:var(--paper-muted)] p-4 md:p-5">
                  <p className="brutal-eyebrow -rotate-1">Stage 02</p>
                  <h2 className="brutal-h2 mt-2">ตั้งค่าหลัก</h2>
                  <p className="mt-2 text-sm font-medium text-[color:var(--text-secondary)]">
                    ตั้งชื่อโปรเจกต์กับเลือกระดับคุณภาพก่อน ที่เหลือระบบช่วยเดาให้ได้
                  </p>
                </div>

                <div className="space-y-4 p-4 md:p-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label htmlFor="project-name" className="mb-2 inline-flex items-center gap-2 brutal-label">
                        Project Name
                        <span title="ใช้เป็นชื่อแสดงผลของโปรเจกต์ในหน้า projects" className="cursor-help">
                          <Info className="h-3.5 w-3.5" />
                        </span>
                      </label>
                      <input
                        id="project-name"
                        type="text"
                        value={config.project_name}
                        onChange={(e) => setConfig({ ...config, project_name: e.target.value })}
                        className="brutal-input"
                        placeholder="My Awesome 3D Model"
                      />
                    </div>
                    <div>
                      <label htmlFor="quality-mode" className="mb-2 inline-flex items-center gap-2 brutal-label">
                        Quality Preset
                        <span title="ถ้าต้องการจูนทุกค่าเอง ให้เลือก Custom" className="cursor-help">
                          <Info className="h-3.5 w-3.5" />
                        </span>
                      </label>
                      <select
                        id="quality-mode"
                        value={config.quality_mode}
                        onChange={(e) => setConfig({ ...config, quality_mode: e.target.value })}
                        className="brutal-select"
                      >
                        <option value="hard">Hard ({getQualityInfo('hard').iterations} iter) • {getQualityInfo('hard').time}</option>
                        <option value="high">High ({getQualityInfo('high').iterations} iter) • {getQualityInfo('high').time}</option>
                        <option value="ultra">Ultra ({getQualityInfo('ultra').iterations} iter) • {getQualityInfo('ultra').time}</option>
                        <option value="professional">Professional ({getQualityInfo('professional').iterations} iter) • {getQualityInfo('professional').time}</option>
                        <option value="ultra_professional">Ultra Professional ({getQualityInfo('ultra_professional').iterations} iter) • {getQualityInfo('ultra_professional').time}</option>
                        <option value="custom">Custom • fine tune all parameters</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="brutal-card-muted p-4">
                      <p className="brutal-label">Preset mood</p>
                      <p className="mt-2 text-lg font-black text-[color:var(--ink)]">{config.quality_mode}</p>
                      <p className="mt-1 text-xs font-medium text-[color:var(--text-secondary)]">{config.quality_mode === 'custom' ? 'Manual control' : qualityInfo.desc}</p>
                    </div>
                    <div className="brutal-card-muted p-4">
                      <p className="brutal-label">Iterations</p>
                      <p className="mt-2 text-lg font-black text-[color:var(--ink)]">{qualityInfo.iterations.toLocaleString()}</p>
                      <p className="mt-1 text-xs font-medium text-[color:var(--text-secondary)]">baseline training rounds</p>
                    </div>
                    <div className="brutal-card-muted p-4">
                      <p className="brutal-label">Estimated time</p>
                      <p className="mt-2 text-lg font-black text-[color:var(--ink)]">{qualityInfo.time}</p>
                      <p className="mt-1 text-xs font-medium text-[color:var(--text-secondary)]">depends on dataset + hardware</p>
                    </div>
                    <div className="brutal-card-muted p-4">
                      <p className="brutal-label">Requirement</p>
                      <p className="mt-2 text-lg font-black text-[color:var(--ink)]">{minimumFilesReached ? 'Ready' : 'Need 10+'}</p>
                      <p className="mt-1 text-xs font-medium text-[color:var(--text-secondary)]">minimum images / frames</p>
                    </div>
                  </div>

                  {config.quality_mode === 'hard' && (
                    <div className="border border-[color:var(--ink)] px-3 py-3 text-sm" style={{ background: 'var(--warning-bg)', color: 'var(--warning-text)' }}>
                      <strong>Hard mode:</strong> เน้น coverage ของ sparse reconstruction ก่อน แล้วค่อย retry เพิ่มคุณภาพภายหลัง
                    </div>
                  )}
                </div>
              </section>

              <section id="stage-pipeline" className="space-y-4">
                <div className={`border p-4 md:p-5 shadow-[var(--shadow-sm)] ${resolvedExpectedPolicy.tone}`} style={{ borderColor: 'var(--ink)' }}>
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="brutal-eyebrow rotate-1">Stage 03</p>
                      <div className="mt-2 flex items-center gap-3">
                        <div className={`flex h-11 w-11 items-center justify-center border shadow-[var(--shadow-sm)] ${resolvedExpectedPolicy.badgeTone}`}>
                          <PolicyIcon className="h-5 w-5" />
                        </div>
                        <div>
                          <h2 className="brutal-h2">{resolvedExpectedPolicy.title}</h2>
                          <p className="text-xs font-medium uppercase tracking-wide opacity-70">
                            {policyPreviewLoading ? 'Refreshing recommendation...' : 'Auto preview from backend heuristic'}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-medium">
                      <span className={`border px-2 py-1 shadow-[2px_2px_0_var(--ink)] ${resolvedExpectedPolicy.badgeTone}`}>{resolvedExpectedPolicy.profileBadge}</span>
                      <span className="border border-[color:var(--ink)] bg-white/70 px-2 py-1" title={resolvedExpectedPolicy.summary}>matcher: {resolvedExpectedPolicy.matcherBadge}</span>
                      <span className="border border-[color:var(--ink)] bg-white/70 px-2 py-1" title={engineRecommendation}>engine: {resolvedExpectedPolicy.engineBadge}</span>
                      {resolvedEstimatedNumImages ? (
                        <span className="border border-[color:var(--ink)] bg-white/70 px-2 py-1">est. frames/images: {resolvedEstimatedNumImages}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="border border-[color:var(--ink)] bg-white/70 p-4">
                      <p className="brutal-label">Confidence</p>
                      <div className="mt-2 flex items-center gap-3">
                        <span className={`border px-2 py-1 text-xs font-semibold shadow-[2px_2px_0_var(--ink)] ${resolvedConfidence.tone}`}>{resolvedConfidence.label}</span>
                        <span className="text-sm font-medium text-gray-600">{resolvedConfidence.score}/100</span>
                      </div>
                      <div className="mt-3 h-2.5 overflow-hidden border border-[color:var(--ink)] bg-gray-200">
                        <div className={`h-full transition-all duration-300 ${resolvedConfidence.meterClass}`} style={{ width: `${resolvedConfidence.score}%` }} />
                      </div>
                    </div>

                    <div className="border border-[color:var(--ink)] bg-white/70 p-4">
                      <p className="brutal-label">Current stack</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-700">
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">feature: {config.feature_method}</span>
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">engine: {getSfmEngineCompactLabel(config.sfm_engine)}</span>
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">quality: {config.quality_mode}</span>
                        {usesGlobalSfm && <span className="border border-[color:var(--ink)] bg-white px-2 py-1">backend: {config.sfm_backend}</span>}
                      </div>
                    </div>

                    <div className="border border-[color:var(--ink)] bg-white/70 p-4">
                      <p className="brutal-label">Signals</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-700">
                        {resolvedConfidenceSignals.slice(0, 6).map((signal) => (
                          <span
                            key={signal.key}
                            title={signal.detail}
                            className={`border px-2 py-1 ${signal.delta >= 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
                          >
                            {signal.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {resolvedPreviewRules.slice(0, 6).map((rule, index) => (
                      <span
                        key={`${rule.level}-${index}`}
                        title={rule.text}
                        className={`inline-flex items-center gap-2 border px-3 py-2 text-xs font-medium ${
                          rule.level === 'warning'
                            ? 'border-amber-200 bg-amber-50 text-amber-900'
                            : 'border-slate-200 bg-white/80 text-slate-700'
                        }`}
                      >
                        <AlertCircle className="h-3.5 w-3.5" />
                        {rule.level === 'warning' ? 'Needs attention' : 'Info'}
                      </span>
                    ))}
                  </div>
                </div>

                <Accordion title="Pipeline Controls" icon={<Sliders className="h-5 w-5" />} badge="Optional" defaultOpen={files.length > 0}>
                  <div className="space-y-6">
                    <div className="brutal-card-muted p-4">
                      <div className="mb-3 flex items-center gap-2">
                        <Zap className="h-4 w-4" />
                        <h3 className="brutal-h3">Engine</h3>
                        <span title={engineRecommendation} className="cursor-help text-[color:var(--text-secondary)]">
                          <Info className="h-4 w-4" />
                        </span>
                      </div>

                      <div className="grid gap-3 lg:grid-cols-3">
                        <label className={`cursor-pointer border-2 p-4 transition-all ${config.sfm_engine === 'glomap' ? 'border-green-500 bg-green-100 shadow-md' : 'border-gray-200 bg-white hover:border-green-300'}`}>
                          <input
                            type="radio"
                            name="sfm_engine"
                            value="glomap"
                            checked={config.sfm_engine === 'glomap'}
                            onChange={(e) => setConfig({ ...config, sfm_engine: e.target.value })}
                            className="sr-only"
                          />
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-bold text-green-700">{getSfmEngineLabel('glomap')}</span>
                            <span className="text-xs font-bold uppercase text-green-700">recommended</span>
                          </div>
                          <p className="mt-2 text-xs text-gray-600">Best for broad photo coverage and safer auto decisions.</p>
                        </label>

                        <label className={`cursor-pointer border-2 p-4 transition-all ${config.sfm_engine === 'fastmap' ? 'border-fuchsia-500 bg-fuchsia-50 shadow-md' : 'border-gray-200 bg-white hover:border-fuchsia-300'}`}>
                          <input
                            type="radio"
                            name="sfm_engine"
                            value="fastmap"
                            checked={config.sfm_engine === 'fastmap'}
                            onChange={(e) => setConfig({ ...config, sfm_engine: e.target.value })}
                            className="sr-only"
                          />
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-bold text-fuchsia-700">FastMap</span>
                            <span className="text-xs font-bold uppercase text-fuchsia-700">speed</span>
                          </div>
                          <p className="mt-2 text-xs text-gray-600">GPU-first option for dense video-style captures.</p>
                        </label>

                        <label className={`cursor-pointer border-2 p-4 transition-all ${config.sfm_engine === 'colmap' ? 'border-blue-500 bg-blue-100 shadow-md' : 'border-gray-200 bg-white hover:border-blue-300'}`}>
                          <input
                            type="radio"
                            name="sfm_engine"
                            value="colmap"
                            checked={config.sfm_engine === 'colmap'}
                            onChange={(e) => setConfig({ ...config, sfm_engine: e.target.value })}
                            className="sr-only"
                          />
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-bold text-blue-700">COLMAP</span>
                            <span className="text-xs font-bold uppercase text-blue-700">classic</span>
                          </div>
                          <p className="mt-2 text-xs text-gray-600">Conservative fallback for harder or edge-case inputs.</p>
                        </label>
                      </div>

                      {usesGlobalSfm && (
                        <div className="mt-4 grid gap-2">
                          <label className="brutal-label inline-flex items-center gap-2">
                            Global SfM Backend
                            <span title="pycolmap ใช้ได้แต่ยังถือว่า experimental ในโปรเจกต์นี้" className="cursor-help">
                              <Info className="h-3.5 w-3.5" />
                            </span>
                          </label>
                          <select
                            value={config.sfm_backend}
                            onChange={(e) => setConfig({ ...config, sfm_backend: e.target.value as SfmBackendMode })}
                            className="brutal-select"
                          >
                            <option value="cli">CLI Global Mapper</option>
                            <option value="pycolmap">pycolmap.global_mapping</option>
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="brutal-card-muted p-4">
                      <div className="mb-3 flex items-center gap-2">
                        <Image className="h-4 w-4" />
                        <h3 className="brutal-h3">Features</h3>
                        <span title="ดูรายละเอียดเพิ่มเติมจาก tooltip ของแต่ละตัวเลือก" className="cursor-help text-[color:var(--text-secondary)]">
                          <Info className="h-4 w-4" />
                        </span>
                      </div>

                      <div className="grid gap-3 lg:grid-cols-3">
                        <label className={`cursor-pointer border-2 p-4 transition-all ${config.feature_method === 'aliked' ? 'border-cyan-500 bg-cyan-50 shadow-md' : 'border-gray-200 bg-white hover:border-cyan-300'}`} title="Native neural features in COLMAP + LightGlue">
                          <input
                            type="radio"
                            name="feature_method"
                            value="aliked"
                            checked={config.feature_method === 'aliked'}
                            onChange={(e) => setConfig({ ...config, feature_method: e.target.value })}
                            className="sr-only"
                          />
                          <p className="font-bold text-cyan-700">ALIKED</p>
                          <p className="mt-1 text-xs text-gray-600">Fast neural path</p>
                        </label>

                        <label className={`cursor-pointer border-2 p-4 transition-all ${config.feature_method === 'superpoint' ? 'border-indigo-500 bg-indigo-50 shadow-md' : 'border-gray-200 bg-white hover:border-indigo-300'}`} title="hloc SuperPoint + LightGlue for stronger matching coverage">
                          <input
                            type="radio"
                            name="feature_method"
                            value="superpoint"
                            checked={config.feature_method === 'superpoint'}
                            onChange={(e) => setConfig({ ...config, feature_method: e.target.value })}
                            className="sr-only"
                          />
                          <p className="font-bold text-indigo-700">SuperPoint</p>
                          <p className="mt-1 text-xs text-gray-600">Quality-first neural path</p>
                        </label>

                        <label className={`cursor-pointer border-2 p-4 transition-all ${config.feature_method === 'sift' ? 'border-gray-500 bg-gray-50 shadow-md' : 'border-gray-200 bg-white hover:border-gray-300'}`} title="Most compatible classic COLMAP features">
                          <input
                            type="radio"
                            name="feature_method"
                            value="sift"
                            checked={config.feature_method === 'sift'}
                            onChange={(e) => setConfig({ ...config, feature_method: e.target.value })}
                            className="sr-only"
                          />
                          <p className="font-bold text-gray-700">SIFT</p>
                          <p className="mt-1 text-xs text-gray-600">Most compatible</p>
                        </label>
                      </div>

                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="mb-2 inline-flex items-center gap-2 brutal-label">
                            COLMAP Resolution
                            <span title="ความละเอียดที่ใช้ตอน extraction / matching" className="cursor-help">
                              <Info className="h-3.5 w-3.5" />
                            </span>
                          </label>
                          <select
                            value={config.colmap_resolution}
                            onChange={(e) => setConfig({ ...config, colmap_resolution: e.target.value })}
                            className="brutal-select"
                          >
                            <option value="720p">720p</option>
                            <option value="1080p">1080p</option>
                            <option value="2K">2K</option>
                            <option value="4K">4K</option>
                            <option value="8K">8K</option>
                            <option value="original">Original</option>
                          </select>
                        </div>
                        <div>
                          <label className="mb-2 inline-flex items-center gap-2 brutal-label">
                            Training Resolution
                            <span title="ความละเอียดที่ใช้ตอน train 3DGS" className="cursor-help">
                              <Info className="h-3.5 w-3.5" />
                            </span>
                          </label>
                          <select
                            value={config.training_resolution}
                            onChange={(e) => setConfig({ ...config, training_resolution: e.target.value })}
                            className="brutal-select"
                          >
                            <option value="1080p">1080p</option>
                            <option value="2K">2K</option>
                            <option value="4K">4K</option>
                            <option value="8K">8K</option>
                            <option value="original">Original</option>
                          </select>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-4 md:grid-cols-2">
                        <div className="border border-[color:var(--ink)] bg-gradient-to-r from-yellow-50 to-orange-50 p-3">
                          <label className="flex cursor-pointer items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Zap className="h-5 w-5 text-yellow-600" />
                              <div>
                                <p className="font-medium text-gray-900">GPU Extraction</p>
                                <p className="text-xs text-gray-600">Faster video decoding</p>
                              </div>
                            </div>
                            <div className="relative">
                              <input
                                type="checkbox"
                                checked={config.use_gpu_extraction}
                                onChange={(e) => setConfig({ ...config, use_gpu_extraction: e.target.checked })}
                                className="sr-only peer"
                              />
                              <div className="h-6 w-11 rounded-full bg-gray-200 peer-checked:bg-yellow-500 peer-checked:after:translate-x-full after:absolute after:left-[2px] after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-['']" />
                            </div>
                          </label>
                        </div>

                        <div className="border border-[color:var(--ink)] bg-gradient-to-r from-yellow-50 to-orange-50 p-3">
                          <label className="flex cursor-pointer items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Zap className="h-5 w-5 text-yellow-600" />
                              <div>
                                <p className="font-medium text-gray-900">Mixed Precision</p>
                                <p className="text-xs text-gray-600">Lower VRAM usage</p>
                              </div>
                            </div>
                            <div className="relative">
                              <input
                                type="checkbox"
                                checked={config.mixed_precision}
                                onChange={(e) => setConfig({ ...config, mixed_precision: e.target.checked })}
                                className="sr-only peer"
                              />
                              <div className="h-6 w-11 rounded-full bg-gray-200 peer-checked:bg-yellow-500 peer-checked:after:translate-x-full after:absolute after:left-[2px] after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-['']" />
                            </div>
                          </label>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="brutal-card-muted p-4">
                        <label className="mb-2 inline-flex items-center gap-2 brutal-label">
                          Feature Matching
                          <span title={matcherRecommendation} className="cursor-help">
                            <Info className="h-3.5 w-3.5" />
                          </span>
                        </label>
                        <select
                          value={config.matcher_type}
                          onChange={(e) => setConfig({ ...config, matcher_type: e.target.value as MatcherMode })}
                          className="brutal-select"
                        >
                          <option value="auto">Auto</option>
                          <option value="sequential">Sequential</option>
                          <option value="exhaustive">Exhaustive</option>
                          <option value="vocab_tree">Vocabulary Tree</option>
                        </select>
                      </div>

                      <div className="brutal-card-muted p-4">
                        <label className="mb-2 inline-flex items-center gap-2 brutal-label">
                          Camera Model
                          <span title="ส่วนใหญ่ SIMPLE_RADIAL ใช้ได้ดีและปลอดภัยที่สุด" className="cursor-help">
                            <Info className="h-3.5 w-3.5" />
                          </span>
                        </label>
                        <select
                          value={config.camera_model}
                          onChange={(e) => setConfig({ ...config, camera_model: e.target.value })}
                          className="brutal-select"
                        >
                          <option value="SIMPLE_RADIAL">SIMPLE_RADIAL</option>
                          <option value="SIMPLE_PINHOLE">SIMPLE_PINHOLE</option>
                          <option value="PINHOLE">PINHOLE</option>
                          <option value="OPENCV">OPENCV</option>
                        </select>
                      </div>
                    </div>

                    <div className="brutal-card-muted p-4">
                      <div className="mb-3 flex items-center gap-2">
                        <Wrench className="h-4 w-4" />
                        <h3 className="brutal-h3">8K / Memory</h3>
                        <span title="ใช้ crop size เฉพาะตอนภาพใหญ่และ VRAM ไม่พอ" className="cursor-help text-[color:var(--text-secondary)]">
                          <Info className="h-4 w-4" />
                        </span>
                      </div>
                      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                        <div>
                          <label className="mb-2 inline-block brutal-label">Crop Size</label>
                          <input
                            type="number"
                            value={config.crop_size}
                            onChange={(e) => setConfig({ ...config, crop_size: parseInt(e.target.value) || 0 })}
                            min="0"
                            max="2048"
                            step="64"
                            className="brutal-input"
                            placeholder="0"
                          />
                        </div>
                        <div className="border border-[color:var(--ink)] bg-white p-3 text-sm text-[color:var(--text-secondary)]">
                          `0` ใช้ภาพเต็มเฟรม, ค่า `512-1024` เหมาะกับภาพ 8K เมื่ออยากลดการใช้ VRAM โดยไม่ต้องลด resolution หลัก
                        </div>
                      </div>
                    </div>

                    {hasVideo && (
                      <div className="brutal-card-muted p-4">
                        <div className="mb-3 flex items-center gap-2">
                          <FileVideo className="h-4 w-4" />
                          <h3 className="brutal-h3">Video Extraction</h3>
                          <span title="รายละเอียดเชิงลึกของ oversampling และ search window ดูได้ใน tooltip" className="cursor-help text-[color:var(--text-secondary)]">
                            <Info className="h-4 w-4" />
                          </span>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <div>
                            <label className="mb-2 inline-block brutal-label">Extraction Mode</label>
                            <select
                              value={config.extraction_mode}
                              onChange={(e) => setConfig({ ...config, extraction_mode: e.target.value })}
                              className="brutal-select"
                            >
                              <option value="fps">Target FPS</option>
                              <option value="target_count">Target Frame Count</option>
                              <option value="frames">Legacy Max Frame Limit</option>
                            </select>
                          </div>

                          <div>
                            {config.extraction_mode === 'frames' ? (
                              <>
                                <label className="mb-2 inline-block brutal-label">Maximum Frames</label>
                                <input
                                  type="number"
                                  value={config.max_frames}
                                  onChange={(e) => setConfig({ ...config, max_frames: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                  min="1"
                                  step="1"
                                  className="brutal-input"
                                />
                              </>
                            ) : config.extraction_mode === 'target_count' ? (
                              <>
                                <label className="mb-2 inline-block brutal-label">Target Frame Count</label>
                                <input
                                  type="number"
                                  value={config.max_frames}
                                  onChange={(e) => setConfig({ ...config, max_frames: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                  min="1"
                                  step="1"
                                  className="brutal-input"
                                />
                              </>
                            ) : (
                              <>
                                <label className="mb-2 inline-block brutal-label">Target FPS</label>
                                <select
                                  value={config.target_fps}
                                  onChange={(e) => setConfig({ ...config, target_fps: parseFloat(e.target.value) })}
                                  className="brutal-select"
                                >
                                  <option value={0.5}>0.5 FPS</option>
                                  <option value={1}>1 FPS</option>
                                  <option value={2}>2 FPS</option>
                                  <option value={5}>5 FPS</option>
                                  <option value={10}>10 FPS</option>
                                  <option value={15}>15 FPS</option>
                                </select>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <div className="border border-[color:var(--ink)] bg-gradient-to-r from-purple-50 to-indigo-50 p-3">
                            <label className="flex cursor-pointer items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Image className="h-5 w-5 text-purple-600" />
                                <div>
                                  <p className="font-medium text-gray-900">Hi-res training images</p>
                                  <p className="text-xs text-gray-600">Separate higher-res frames for training</p>
                                </div>
                              </div>
                              <div className="relative">
                                <input
                                  type="checkbox"
                                  checked={config.use_separate_training_images}
                                  onChange={(e) => setConfig({ ...config, use_separate_training_images: e.target.checked })}
                                  className="sr-only peer"
                                />
                                <div className="h-6 w-11 rounded-full bg-gray-200 peer-checked:bg-purple-500 peer-checked:after:translate-x-full after:absolute after:left-[2px] after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-['']" />
                              </div>
                            </label>
                          </div>

                          <div className="border border-[color:var(--ink)] bg-gradient-to-r from-sky-50 to-cyan-50 p-3">
                            <label className="flex cursor-pointer items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Image className="h-5 w-5 text-sky-600" />
                                <div>
                                  <p className="font-medium text-gray-900">Oversample and select</p>
                                  <p className="text-xs text-gray-600">Keep sharper frames from a denser candidate pool</p>
                                </div>
                              </div>
                              <div className="relative">
                                <input
                                  type="checkbox"
                                  checked={config.smart_frame_selection}
                                  onChange={(e) => setConfig({ ...config, smart_frame_selection: e.target.checked })}
                                  className="sr-only peer"
                                />
                                <div className="h-6 w-11 rounded-full bg-gray-200 peer-checked:bg-sky-500 peer-checked:after:translate-x-full after:absolute after:left-[2px] after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-['']" />
                              </div>
                            </label>
                          </div>
                        </div>

                        <div className="mt-4 grid gap-4 md:grid-cols-3">
                          <div>
                            <label className="mb-2 inline-flex items-center gap-2 brutal-label">
                              CPU Chunk Workers
                              <span title="process ที่ใช้ถอดภาพพร้อมกันจากวิดีโอ" className="cursor-help">
                                <Info className="h-3.5 w-3.5" />
                              </span>
                            </label>
                            <select
                              value={config.ffmpeg_cpu_workers}
                              onChange={(e) => setConfig({ ...config, ffmpeg_cpu_workers: parseInt(e.target.value, 10) })}
                              className="brutal-select"
                            >
                              <option value={2}>2 workers</option>
                              <option value={4}>4 workers</option>
                              <option value={8}>8 workers</option>
                            </select>
                          </div>

                          <div>
                            <label className="mb-2 inline-flex items-center gap-2 brutal-label">
                              Oversample Factor
                              <span title={`Candidate pool: ${estimatedCandidatePool}`} className="cursor-help">
                                <Info className="h-3.5 w-3.5" />
                              </span>
                            </label>
                            <select
                              value={config.oversample_factor}
                              onChange={(e) => setConfig({ ...config, oversample_factor: parseInt(e.target.value, 10) || 10 })}
                              className="brutal-select"
                              disabled={!config.smart_frame_selection}
                            >
                              <option value={5}>5x</option>
                              <option value={10}>10x</option>
                              <option value={15}>15x</option>
                              <option value={20}>20x</option>
                            </select>
                          </div>

                          <div>
                            <label className="mb-2 inline-flex items-center gap-2 brutal-label">
                              Search Radius
                              <span title={`Estimated search window: ${estimatedSearchWindow}`} className="cursor-help">
                                <Info className="h-3.5 w-3.5" />
                              </span>
                            </label>
                            <select
                              value={config.replacement_search_radius}
                              onChange={(e) => setConfig({ ...config, replacement_search_radius: parseInt(e.target.value) || 4 })}
                              className="brutal-select"
                              disabled={!config.smart_frame_selection}
                            >
                              <option value={2}>±2</option>
                              <option value={4}>±4</option>
                              <option value={6}>±6</option>
                              <option value={8}>±8</option>
                              <option value={12}>±12</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    )}

                    {config.quality_mode === 'custom' && (
                      <Accordion title="Expert Settings" icon={<Wrench className="h-5 w-5" />} badge="Custom">
                        <div className="space-y-4">
                          <div className="border-b border-purple-200 pb-3">
                            <h5 className="mb-2 text-sm font-semibold text-purple-900">OpenSplat Training</h5>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div title="จำนวนรอบการเทรน - มากขึ้น = คุณภาพดีขึ้น แต่ใช้เวลานานขึ้น">
                                <p className="mb-1 brutal-label cursor-help">Training Iterations</p>
                                <input
                                  type="number"
                                  value={customParams.iterations}
                                  onChange={(e) => setCustomParams({ ...customParams, iterations: parseInt(e.target.value) || 7000 })}
                                  min="100"
                                  max="50000"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="ค่าเกณฑ์การเพิ่ม Gaussian splats - ต่ำกว่า = splats หนาแน่นกว่า">
                                <p className="mb-1 brutal-label cursor-help">Densify Grad Threshold</p>
                                <input
                                  type="number"
                                  value={customParams.densify_grad_threshold}
                                  onChange={(e) => setCustomParams({ ...customParams, densify_grad_threshold: parseFloat(e.target.value) || 0.00015 })}
                                  min="0.00001"
                                  max="0.001"
                                  step="0.00001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="ความถี่การปรับแต่ง Gaussians">
                                <p className="mb-1 brutal-label cursor-help">Refine Every</p>
                                <input
                                  type="number"
                                  value={customParams.refine_every}
                                  onChange={(e) => setCustomParams({ ...customParams, refine_every: parseInt(e.target.value) || 75 })}
                                  min="10"
                                  max="500"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="ระยะ warmup ของ learning rate">
                                <p className="mb-1 brutal-label cursor-help">Warmup Length</p>
                                <input
                                  type="number"
                                  value={customParams.warmup_length}
                                  onChange={(e) => setCustomParams({ ...customParams, warmup_length: parseInt(e.target.value) || 750 })}
                                  min="100"
                                  max="2000"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="น้ำหนักของ SSIM loss">
                                <p className="mb-1 brutal-label cursor-help">SSIM Weight</p>
                                <input
                                  type="number"
                                  value={customParams.ssim_weight}
                                  onChange={(e) => setCustomParams({ ...customParams, ssim_weight: parseFloat(e.target.value) || 0.25 })}
                                  min="0"
                                  max="1"
                                  step="0.01"
                                  className="brutal-input"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="border-b border-purple-200 pb-3 pt-2">
                            <h5 className="mb-2 text-sm font-semibold text-purple-900">Learning Rates</h5>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div title="Main learning rate">
                                <p className="mb-1 brutal-label cursor-help">Learning Rate</p>
                                <input
                                  type="number"
                                  value={customParams.learning_rate}
                                  onChange={(e) => setCustomParams({ ...customParams, learning_rate: parseFloat(e.target.value) || 0.0025 })}
                                  min="0.0001"
                                  max="0.01"
                                  step="0.0001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="Initial position learning rate">
                                <p className="mb-1 brutal-label cursor-help">Position LR Init</p>
                                <input
                                  type="number"
                                  value={customParams.position_lr_init}
                                  onChange={(e) => setCustomParams({ ...customParams, position_lr_init: parseFloat(e.target.value) || 0.00016 })}
                                  min="0.00001"
                                  max="0.001"
                                  step="0.00001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="Final position learning rate">
                                <p className="mb-1 brutal-label cursor-help">Position LR Final</p>
                                <input
                                  type="number"
                                  value={customParams.position_lr_final}
                                  onChange={(e) => setCustomParams({ ...customParams, position_lr_final: parseFloat(e.target.value) || 0.0000016 })}
                                  min="0.0000001"
                                  max="0.0001"
                                  step="0.0000001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="Feature learning rate">
                                <p className="mb-1 brutal-label cursor-help">Feature LR</p>
                                <input
                                  type="number"
                                  value={customParams.feature_lr}
                                  onChange={(e) => setCustomParams({ ...customParams, feature_lr: parseFloat(e.target.value) || 0.0025 })}
                                  min="0.0001"
                                  max="0.01"
                                  step="0.0001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="Opacity learning rate">
                                <p className="mb-1 brutal-label cursor-help">Opacity LR</p>
                                <input
                                  type="number"
                                  value={customParams.opacity_lr}
                                  onChange={(e) => setCustomParams({ ...customParams, opacity_lr: parseFloat(e.target.value) || 0.05 })}
                                  min="0.001"
                                  max="0.5"
                                  step="0.001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="Scaling learning rate">
                                <p className="mb-1 brutal-label cursor-help">Scaling LR</p>
                                <input
                                  type="number"
                                  value={customParams.scaling_lr}
                                  onChange={(e) => setCustomParams({ ...customParams, scaling_lr: parseFloat(e.target.value) || 0.005 })}
                                  min="0.0001"
                                  max="0.05"
                                  step="0.0001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="Rotation learning rate">
                                <p className="mb-1 brutal-label cursor-help">Rotation LR</p>
                                <input
                                  type="number"
                                  value={customParams.rotation_lr}
                                  onChange={(e) => setCustomParams({ ...customParams, rotation_lr: parseFloat(e.target.value) || 0.001 })}
                                  min="0.0001"
                                  max="0.01"
                                  step="0.0001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="Percentage of dense points">
                                <p className="mb-1 brutal-label cursor-help">Percent Dense</p>
                                <input
                                  type="number"
                                  value={customParams.percent_dense}
                                  onChange={(e) => setCustomParams({ ...customParams, percent_dense: parseFloat(e.target.value) || 0.01 })}
                                  min="0.001"
                                  max="0.5"
                                  step="0.001"
                                  className="brutal-input"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="border-b border-purple-200 pb-3 pt-2">
                            <h5 className="mb-2 text-sm font-semibold text-purple-900">SIFT Feature Quality</h5>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div title="SIFT peak threshold">
                                <p className="mb-1 brutal-label cursor-help">Peak Threshold</p>
                                <input
                                  type="number"
                                  value={customParams.peak_threshold}
                                  onChange={(e) => setCustomParams({ ...customParams, peak_threshold: parseFloat(e.target.value) || 0.01 })}
                                  min="0.001"
                                  max="0.1"
                                  step="0.001"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="SIFT edge threshold">
                                <p className="mb-1 brutal-label cursor-help">Edge Threshold</p>
                                <input
                                  type="number"
                                  value={customParams.edge_threshold}
                                  onChange={(e) => setCustomParams({ ...customParams, edge_threshold: parseFloat(e.target.value) || 15 })}
                                  min="5"
                                  max="30"
                                  step="1"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="จำนวน orientations ต่อ keypoint">
                                <p className="mb-1 brutal-label cursor-help">Max Num Orientations</p>
                                <input
                                  type="number"
                                  value={customParams.max_num_orientations}
                                  onChange={(e) => setCustomParams({ ...customParams, max_num_orientations: parseInt(e.target.value) || 2 })}
                                  min="1"
                                  max="5"
                                  className="brutal-input"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="border-b border-purple-200 pb-3 pt-2">
                            <h5 className="mb-2 text-sm font-semibold text-purple-900">Feature Extraction & Matching</h5>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div title="จำนวน SIFT features สูงสุดต่อภาพ">
                                <p className="mb-1 brutal-label cursor-help">Max Features per Image</p>
                                <input
                                  type="number"
                                  value={customParams.max_num_features}
                                  onChange={(e) => setCustomParams({ ...customParams, max_num_features: parseInt(e.target.value) || 12288 })}
                                  min="1024"
                                  max="32768"
                                  step="1024"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="จำนวน match points สูงสุดต่อ image pair">
                                <p className="mb-1 brutal-label cursor-help">Max Matches per Pair</p>
                                <input
                                  type="number"
                                  value={customParams.max_num_matches}
                                  onChange={(e) => setCustomParams({ ...customParams, max_num_matches: parseInt(e.target.value) || 32768 })}
                                  min="4096"
                                  max="65536"
                                  step="4096"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="จำนวนภาพที่แต่ละภาพจะจับคู่ด้วย">
                                <p className="mb-1 brutal-label cursor-help">Sequential Overlap</p>
                                <input
                                  type="number"
                                  value={customParams.sequential_overlap}
                                  onChange={(e) => setCustomParams({ ...customParams, sequential_overlap: parseInt(e.target.value) || 18 })}
                                  min="5"
                                  max="50"
                                  className="brutal-input"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="pt-2">
                            <h5 className="mb-2 text-sm font-semibold text-purple-900">Sparse Reconstruction</h5>
                            <div className="grid gap-3 md:grid-cols-2">
                              <div title="จำนวน matches ขั้นต่ำที่ยอมรับ">
                                <p className="mb-1 brutal-label cursor-help">Min Num Matches</p>
                                <input
                                  type="number"
                                  value={customParams.min_num_matches}
                                  onChange={(e) => setCustomParams({ ...customParams, min_num_matches: parseInt(e.target.value) || 16 })}
                                  min="6"
                                  max="50"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="จำนวนโมเดลสูงสุดที่ลองสร้าง">
                                <p className="mb-1 brutal-label cursor-help">Max Num Models</p>
                                <input
                                  type="number"
                                  value={customParams.max_num_models}
                                  onChange={(e) => setCustomParams({ ...customParams, max_num_models: parseInt(e.target.value) || 40 })}
                                  min="5"
                                  max="100"
                                  className="brutal-input"
                                />
                              </div>
                              <div title="จำนวนครั้งที่ลอง initialize reconstruction">
                                <p className="mb-1 brutal-label cursor-help">Init Num Trials</p>
                                <input
                                  type="number"
                                  value={customParams.init_num_trials}
                                  onChange={(e) => setCustomParams({ ...customParams, init_num_trials: parseInt(e.target.value) || 225 })}
                                  min="50"
                                  max="500"
                                  className="brutal-input"
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </Accordion>
                    )}
                  </div>
                </Accordion>
              </section>

              <section id="stage-launch" className="brutal-card overflow-hidden">
                <div className="border-b border-[color:var(--ink)] bg-[color:var(--paper-muted)] p-4 md:p-5">
                  <p className="brutal-eyebrow rotate-1">Stage 04</p>
                  <h2 className="brutal-h2 mt-2">ตรวจสอบแล้วเริ่มประมวลผล</h2>
                  <p className="mt-2 text-sm font-medium text-[color:var(--text-secondary)]">
                    จุดนี้เหลือแค่เช็กภาพรวม ถ้าต้องการรายละเอียดเชิงลึกค่อยย้อนกลับไปที่ Pipeline Controls
                  </p>
                </div>

                <div className="space-y-5 p-4 md:p-5">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="brutal-card-muted p-4">
                      <CheckCircle className="h-6 w-6" style={{ color: minimumFilesReached ? 'var(--success-icon)' : 'var(--warning-text)' }} />
                      <h3 className="mt-3 text-sm font-black uppercase tracking-wide text-[color:var(--ink)]">Dataset size</h3>
                      <p className="mt-1 text-sm font-medium text-[color:var(--text-secondary)]">
                        {minimumFilesReached ? 'พร้อมสำหรับ reconstruction' : 'ควรมีอย่างน้อย 10 ภาพหรือเฟรม'}
                      </p>
                    </div>
                    <div className="brutal-card-muted p-4">
                      <Settings className="h-6 w-6 text-[color:var(--ink)]" />
                      <h3 className="mt-3 text-sm font-black uppercase tracking-wide text-[color:var(--ink)]">Pipeline auto mode</h3>
                      <p className="mt-1 text-sm font-medium text-[color:var(--text-secondary)]">
                        Matcher {config.matcher_type === 'auto' ? 'ยังเป็น Auto' : `override เป็น ${getMatcherLabelWithMode(config.matcher_type)}`}
                      </p>
                    </div>
                    <div className="brutal-card-muted p-4">
                      <Info className="h-6 w-6 text-[color:var(--ink)]" />
                      <h3 className="mt-3 text-sm font-black uppercase tracking-wide text-[color:var(--ink)]">Expected time</h3>
                      <p className="mt-1 text-sm font-medium text-[color:var(--text-secondary)]">
                        ประมาณ {qualityInfo.time} สำหรับ preset นี้
                      </p>
                    </div>
                  </div>

                  {uploading ? (
                    <div className="space-y-3">
                      <div className="h-3 w-full overflow-hidden border border-[color:var(--ink)] bg-gray-100">
                        <div
                          className="relative h-3 bg-[color:var(--ink-600)] transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        >
                          {uploadProgress > 5 && (
                            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white">
                              {uploadProgress}%
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-sm font-medium text-[color:var(--text-secondary)]">
                        <span>{formatFileSize(uploadedBytes)} / {formatFileSize(totalSize)}</span>
                        <span>{uploadSpeed > 0 ? `${formatFileSize(uploadSpeed)}/s` : 'Starting...'}</span>
                      </div>
                      <p className="text-center text-xs font-medium text-[color:var(--text-secondary)]">
                        {uploadProgress < 100
                          ? uploadSpeed > 0
                            ? `Estimated time: ~${Math.ceil((totalSize - uploadedBytes) / uploadSpeed)}s remaining`
                            : 'Calculating speed...'
                          : 'Upload complete. Processing will start automatically...'}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col justify-between gap-3 border border-[color:var(--ink)] bg-[color:var(--paper-card)] p-4 md:flex-row md:items-center">
                      <div className="text-sm font-medium text-[color:var(--text-secondary)]">
                        ระบบจะพาไปหน้า live processing อัตโนมัติหลัง upload สำเร็จ
                      </div>
                      <div className="flex gap-3">
                        <button type="button" onClick={() => setFiles([])} className="brutal-btn" disabled={files.length === 0}>
                          Clear All
                        </button>
                        <button
                          type="button"
                          onClick={handleUpload}
                          disabled={files.length === 0}
                          className={`brutal-btn brutal-btn-primary ${files.length === 0 ? 'pointer-events-none opacity-50' : ''}`}
                        >
                          <Settings className="mr-2 h-5 w-5" />
                          Start Creating 3D Model
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
