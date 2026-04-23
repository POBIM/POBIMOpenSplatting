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
    adaptive_frame_budget: true,
    oversample_factor: 10,
    replacement_search_radius: 4,
    ffmpeg_cpu_workers: 4,
    sfm_engine: 'glomap',  // Legacy alias kept for backend compatibility; UI shows COLMAP Global SfM
    sfm_backend: 'cli' as SfmBackendMode,
    feature_method: 'sift',  // 'sift' (classic COLMAP), 'aliked' (native COLMAP neural), 'superpoint' (hloc)
    adaptive_pair_scheduling: true,
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

  const formatSignedScore = (value: number) => {
    if (value > 0) return `+${value}`;
    return `${value}`;
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
  const adaptiveComparisons = policyPreview?.adaptive_comparisons ?? [];
  const autoTuningSummary = policyPreview?.auto_tuning_summary;
  const autoTuningLabel = autoTuningSummary
    ? autoTuningSummary.active_label
      ?? autoTuningSummary.source_label
      ?? autoTuningSummary.active_snapshot
      ?? autoTuningSummary.mode
      ?? 'auto tuning'
    : null;
  const autoTuningTone = autoTuningSummary?.fallback_to_stable
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : (autoTuningSummary?.active_snapshot || autoTuningSummary?.mode || '').toLowerCase().includes('tuned')
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-slate-200 bg-slate-50 text-slate-700';
  const autoTuningSurfaces = autoTuningSummary
    ? [
        { label: 'Extraction', surface: autoTuningSummary.extraction },
        { label: 'Matching', surface: autoTuningSummary.matching },
        { label: 'Recovery', surface: autoTuningSummary.recovery },
        { label: 'Orchestration', surface: autoTuningSummary.orchestration },
      ].filter((entry) => Boolean(entry.surface?.summary || entry.surface?.label || entry.surface?.status))
    : [];
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

  return (
    <div className="brutal-shell">
      <section className="brutal-section">
        <div className="brutal-container max-w-5xl space-y-6">
          <div className="space-y-3">
            <span className="brutal-eyebrow rotate-1">Upload Wizard</span>
            <div>
              <h1 className="brutal-h1">Upload Media</h1>
              <p className="mt-2 text-sm font-medium text-[color:var(--text-secondary)]">Upload images or videos for 3D reconstruction</p>
            </div>
          </div>

      <div
        className={`relative overflow-hidden border-2 border-dashed p-8 text-center transition-all md:p-10 ${isDragging
          ? 'border-[color:var(--ink)] bg-[color:var(--paper-muted)] shadow-[var(--shadow-md)]'
          : 'border-[color:var(--ink)] bg-[color:var(--paper-card)] shadow-[var(--shadow-sm)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]'
          }`}
      >
        {files.length === 0 ? (
          <label
            htmlFor="file-input"
            className="block cursor-pointer"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center border border-[color:var(--ink)] bg-[color:var(--paper-muted)] shadow-[var(--shadow-sm)]">
              <Upload className="h-7 w-7 text-[color:var(--ink)]" />
            </div>
            <p className="brutal-h2 mb-2">
              Drop your files here or click to browse
            </p>
            <p className="mx-auto mb-6 max-w-xl text-sm font-medium text-[color:var(--text-secondary)]">
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
            <span className="brutal-btn brutal-btn-primary">
              Choose Files
            </span>
          </label>
        ) : (
          <div className="space-y-6">
            {/* File List */}
            <div className="brutal-card-muted p-3 md:p-4 text-left">
              <div className="flex items-center justify-between gap-3">
                <h4 className="brutal-h3">Selected Files ({files.length})</h4>
                <span className="brutal-badge -rotate-1">{formatFileSize(totalSize)}</span>
              </div>
              <div className="brutal-scroll mt-4 space-y-2 max-h-48 overflow-y-auto pr-1">
                {files.map((file, index) => (
                  <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between border border-[color:var(--ink)] bg-[color:var(--paper-card)] p-3">
                    <div className="flex items-center space-x-3">
                      {file.type.startsWith('video/') ? (
                        <FileVideo className="h-4 w-4 text-[color:var(--ink)]" />
                      ) : (
                        <Image className="h-4 w-4 text-[color:var(--ink)]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-black uppercase tracking-tight text-[color:var(--ink)] truncate">{file.name}</p>
                        <p className="text-xs font-medium text-[color:var(--text-secondary)]">
                          {formatFileSize(file.size)} • {file.type.startsWith('video/') ? 'Video' : 'Image'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="brutal-btn brutal-btn-xs"
                    >
                      <AlertCircle className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-[color:var(--text-secondary)]">Total size: {formatFileSize(totalSize)}</p>
            </div>

            {/* Configuration Options */}
            <div className="space-y-6">
              {/* Project Details */}
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="project-name" className="brutal-label mb-2 inline-block">Project Name</label>
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
                  <label htmlFor="quality-mode" className="brutal-label mb-2 inline-block">Quality Preset</label>
                  <select
                    id="quality-mode"
                    value={config.quality_mode}
                    onChange={(e) => setConfig({ ...config, quality_mode: e.target.value })}
                    className="brutal-select"
                  >
                    <option value="hard">🧱 Hard ({getQualityInfo('hard').iterations} iter) - {getQualityInfo('hard').time} - AGGRESSIVE COVERAGE</option>
                    <option value="high">🎯 High ({getQualityInfo('high').iterations} iter) - {getQualityInfo('high').time}</option>
                    <option value="ultra">✨ Ultra ({getQualityInfo('ultra').iterations} iter) - {getQualityInfo('ultra').time}</option>
                    <option value="professional">💎 Professional ({getQualityInfo('professional').iterations} iter) - {getQualityInfo('professional').time} - 4K+ SUPPORT</option>
                    <option value="ultra_professional">🏆 Ultra Professional ({getQualityInfo('ultra_professional').iterations} iter) - {getQualityInfo('ultra_professional').time} - HIGHEST QUALITY</option>
                    <option value="custom">⚙️ Custom - Fine-tune all parameters</option>
                  </select>
                  <p className="mt-2 text-xs font-medium text-[color:var(--text-secondary)]">
                    {config.quality_mode === 'custom' ? 'Fine-tune all parameters' : getQualityInfo(config.quality_mode).desc}
                  </p>
                  {config.quality_mode === 'hard' && (
                    <div className="mt-3 border border-[color:var(--ink)] px-3 py-3 text-sm" style={{ background: 'var(--warning-bg)', color: 'var(--warning-text)' }}>
                      <strong>Hard mode plan:</strong> เน้นเก็บ sparse coverage และ feature matching ให้กว้างก่อน โดยเริ่มเทรนเพียง 5000 รอบ
                      ถ้าภาพรวมดีค่อย Retry ต่อเป็น Professional หรือเพิ่ม iterations ภายหลัง
                    </div>
                  )}
                </div>
              </div>

              <div className={`border p-4 md:p-5 shadow-[var(--shadow-sm)] ${resolvedExpectedPolicy.tone}`} style={{ borderColor: 'var(--ink)' }}>
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                      <p className="brutal-label opacity-70">Expected Policy</p>
                      <div className="mt-1 flex items-center gap-3">
                        <div className={`flex h-10 w-10 items-center justify-center border shadow-[var(--shadow-sm)] ${resolvedExpectedPolicy.badgeTone}`}>
                          <PolicyIcon className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="brutal-h3">{resolvedExpectedPolicy.title}</h3>
                          <p className="text-xs font-medium uppercase tracking-wide opacity-70">
                            {policyPreviewLoading ? 'Refreshing backend heuristic...' : 'Resolved from backend preview heuristic'}
                          </p>
                        </div>
                      </div>
                      <p className="mt-2 text-sm font-medium opacity-90">{resolvedExpectedPolicy.summary}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-medium">
                      <span className={`border px-2 py-1 shadow-[2px_2px_0_var(--ink)] ${resolvedExpectedPolicy.badgeTone}`}>{resolvedExpectedPolicy.profileBadge}</span>
                      <span className="border border-[color:var(--ink)] bg-white/70 px-2 py-1">matcher: {resolvedExpectedPolicy.matcherBadge}</span>
                      <span className="border border-[color:var(--ink)] bg-white/70 px-2 py-1">engine: {resolvedExpectedPolicy.engineBadge}</span>
                      {resolvedEstimatedNumImages ? (
                        <span className="border border-[color:var(--ink)] bg-white/70 px-2 py-1">est. frames/images: {resolvedEstimatedNumImages}</span>
                      ) : null}
                    </div>
                  </div>
                  {policyPreviewLoading && (
                  <div className="mt-4 space-y-3 border border-[color:var(--ink)] bg-white/40 p-4 animate-pulse">
                    <div className="h-2 w-32 bg-white/80" />
                    <div className="h-3 w-full bg-white/70" />
                    <div className="h-3 w-4/5 bg-white/60" />
                  </div>
                )}
                <div className="mt-4 border border-[color:var(--ink)] bg-white/70 p-4 text-gray-900 shadow-[var(--shadow-sm)]">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="brutal-label">Preview Confidence</p>
                      <div className="mt-1 flex items-center gap-3">
                        <span className={`border px-2 py-1 text-xs font-semibold shadow-[2px_2px_0_var(--ink)] ${resolvedConfidence.tone}`}>{resolvedConfidence.label}</span>
                        <span className="text-sm font-medium text-gray-600">score {resolvedConfidence.score}/100</span>
                      </div>
                    </div>
                    <div className="text-xs font-medium text-gray-500">
                      Signals: {resolvedConfidenceSignals.slice(0, 3).map((signal) => signal.label).join(' • ')}
                    </div>
                  </div>
                  <div className="mt-3 h-2.5 overflow-hidden border border-[color:var(--ink)] bg-gray-200">
                    <div
                      className={`h-full transition-all duration-300 ${resolvedConfidence.meterClass}`}
                      style={{ width: `${resolvedConfidence.score}%` }}
                    />
                  </div>
                  {policyPreviewLoading && (
                    <div className="mt-3 grid gap-2 md:grid-cols-3 animate-pulse">
                      <div className="h-8 border border-[color:var(--ink)] bg-gray-200/80" />
                      <div className="h-8 border border-[color:var(--ink)] bg-gray-200/70" />
                      <div className="h-8 border border-[color:var(--ink)] bg-gray-200/60" />
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-600">
                    {resolvedConfidenceSignals.map((signal) => (
                      <span
                        key={signal.key}
                        className={`border px-2 py-1 ${signal.delta >= 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
                        title={`${signal.label}: ${signal.detail} (${signal.delta >= 0 ? '+' : ''}${signal.delta})`}
                      >
                        {signal.label} {signal.delta >= 0 ? `+${signal.delta}` : signal.delta}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-600">
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">feature: {config.feature_method}</span>
                      {usesGlobalSfm && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">backend: {config.sfm_backend}</span>
                      )}
                      {hasVideo && config.extraction_mode === 'fps' && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">target fps: {config.target_fps}</span>
                      )}
                      {hasVideo && config.extraction_mode === 'target_count' && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">target frames: {config.max_frames}</span>
                      )}
                      {hasVideo && config.extraction_mode === 'frames' && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">max frames: {config.max_frames}</span>
                      )}
                      {hasVideo && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                          hi-res training: {config.use_separate_training_images ? 'enabled' : 'off'}
                        </span>
                      )}
                      {hasVideo && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                          chunk workers: {config.ffmpeg_cpu_workers}
                        </span>
                      )}
                      {hasVideo && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                          oversample mode: {config.smart_frame_selection ? `${config.oversample_factor}x` : 'off'}
                        </span>
                      )}
                      {hasVideo && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                          adaptive frame budget: {config.adaptive_frame_budget && config.smart_frame_selection ? 'on' : 'off'}
                        </span>
                      )}
                      {hasVideo && (
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                          adaptive pair scheduling: {config.adaptive_pair_scheduling ? 'on' : 'off'}
                        </span>
                      )}
                  </div>
                </div>
                {autoTuningSummary && (
                  <div className="mt-4 border border-[color:var(--ink)] bg-white/70 p-4 text-gray-900 shadow-[var(--shadow-sm)]">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="brutal-label">Policy Source</p>
                        <p className="mt-1 text-sm text-gray-700">
                          Upcoming self-tuning decisions will surface here without replacing the stable defaults silently.
                        </p>
                      </div>
                      {autoTuningLabel && (
                        <span className={`border px-2 py-1 text-[11px] font-semibold ${autoTuningTone}`}>
                          {autoTuningLabel}
                        </span>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-600">
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                        runs: {autoTuningSummary.derived_from_runs ?? '--'}
                      </span>
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                        confidence: {typeof autoTuningSummary.confidence === 'number' ? autoTuningSummary.confidence : autoTuningSummary.confidence || '--'}
                      </span>
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                        schema: {autoTuningSummary.schema_version ?? '--'}
                      </span>
                      <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                        tuned values: {autoTuningSummary.tuned_value_count ?? '--'}
                      </span>
                    </div>
                    {(autoTuningSummary.summary || autoTuningSummary.fallback_reason) && (
                      <div className="mt-3 border border-[color:var(--ink)] bg-slate-50 px-3 py-2 text-sm text-gray-700">
                        {autoTuningSummary.summary || 'No tuning summary recorded yet.'}
                        {autoTuningSummary.fallback_reason ? ` • fallback=${autoTuningSummary.fallback_reason}` : ''}
                      </div>
                    )}
                    {!!autoTuningSurfaces.length && (
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {autoTuningSurfaces.map(({ label, surface }) => (
                          <div key={label} className="border border-[color:var(--ink)] bg-white px-3 py-2 text-sm text-gray-700">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-gray-900">{label}</span>
                              {surface?.label && <span className="border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700">{surface.label}</span>}
                              <span className={`border px-2 py-1 text-[11px] font-semibold ${surface?.tuned ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                                {surface?.tuned ? 'tuned' : 'stable'}
                              </span>
                            </div>
                            <p className="mt-2">{surface?.summary || surface?.status || 'No summary recorded.'}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {adaptiveComparisons.length > 0 && (
                  <div className="mt-4 border border-[color:var(--ink)] bg-white/70 p-4 text-gray-900 shadow-[var(--shadow-sm)]">
                    <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
                      <div>
                        <p className="brutal-label">Adaptive Resource Preview</p>
                        <p className="mt-1 text-sm text-gray-700">
                          Ordered-video resource policy deltas against the opposite flag state.
                        </p>
                      </div>
                      <div className="text-xs font-medium text-gray-500">
                        Backend comparison, not a static UI hint
                        {policyPreview?.resource_contract?.schema_version ? ` • ${policyPreview.resource_contract.schema_version}` : ''}
                      </div>
                    </div>
                    {policyPreview?.resource_contract && (
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-600">
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                          profiles: {policyPreview.resource_contract.benchmark_profiles?.length ?? 0}
                        </span>
                        <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                          metrics: {policyPreview.resource_contract.metric_keys?.length ?? 0}
                        </span>
                      </div>
                    )}
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      {adaptiveComparisons.map((comparison) => {
                        const betterWhenEnabled = comparison.score_delta_enabled_vs_disabled >= 0;
                        const matchesRecommendation = comparison.current_enabled === comparison.recommended_enabled;
                        const statusClass = comparison.available
                          ? matchesRecommendation
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                            : 'border-amber-200 bg-amber-50 text-amber-900'
                          : 'border-slate-200 bg-slate-50 text-slate-700';

                        return (
                          <div
                            key={comparison.key}
                            className="border border-[color:var(--ink)] bg-white p-4 shadow-[var(--shadow-sm)]"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-gray-900">{comparison.label}</span>
                              <span className={`border px-2 py-1 text-[11px] font-semibold ${comparison.current_enabled ? 'border-emerald-200 bg-emerald-100 text-emerald-900' : 'border-slate-200 bg-slate-100 text-slate-700'}`}>
                                current: {comparison.current_enabled ? 'on' : 'off'}
                              </span>
                              <span className={`border px-2 py-1 text-[11px] font-semibold ${statusClass}`}>
                                {comparison.available
                                  ? `recommended: ${comparison.recommended_enabled ? 'on' : 'off'}`
                                  : 'gated'}
                              </span>
                            </div>
                            <p className="mt-2 text-sm text-gray-700">{comparison.effect}</p>
                            <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-600">
                              <span className={`border px-2 py-1 ${betterWhenEnabled ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
                                on vs off: {formatSignedScore(comparison.score_delta_enabled_vs_disabled)} confidence
                              </span>
                              <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                                current score: {comparison.current_score}
                              </span>
                              <span className="border border-[color:var(--ink)] bg-white px-2 py-1">
                                alternate score: {comparison.alternative_score}
                              </span>
                            </div>
                            <div className="mt-3 space-y-2 text-sm text-gray-700">
                              <div className="border border-[color:var(--ink)] bg-slate-50 px-3 py-2">
                                <span className="font-semibold text-gray-900">Current:</span> {comparison.current_summary}
                              </div>
                              <div className="border border-[color:var(--ink)] bg-white px-3 py-2">
                                <span className="font-semibold text-gray-900">Alternate:</span> {comparison.alternative_summary}
                              </div>
                              {comparison.gate && (
                                <div className="border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                                  {comparison.gate}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="mt-4 grid gap-2 md:grid-cols-3">
                  {policyLegend.map((entry) => {
                    const LegendIcon = entry.icon;
                    const isActive = entry.key === resolvedInputProfile;

                    return (
                      <div
                        key={entry.key}
                        className={`border px-3 py-3 shadow-[var(--shadow-sm)] ${isActive ? entry.toneClass : 'border-[color:var(--ink)] bg-white text-gray-600'}`}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span className={`h-2.5 w-2.5 rounded-full ${entry.dotClass}`} />
                          <LegendIcon className="h-4 w-4" />
                          <span>{entry.label}</span>
                        </div>
                        <p className="mt-1 text-xs opacity-80">{entry.detail}</p>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 space-y-2">
                    <p className="brutal-label opacity-70">Live Rule Preview</p>
                  {resolvedPreviewRules.map((rule, index) => (
                    <div
                      key={`${rule.level}-${index}`}
                      className={`flex items-start gap-2 border px-3 py-2 text-sm ${
                        rule.level === 'warning'
                          ? 'border-amber-200 bg-amber-50 text-amber-900'
                          : 'border-slate-200 bg-white/80 text-slate-700'
                      }`}
                    >
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{rule.text}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-xs opacity-75">
                  This is a pre-upload recommendation only. After matching, the backend can still refine the policy again from pair geometry.
                </p>
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
              <div className="brutal-card-muted p-3 md:p-4 text-left">
                <h4 className="brutal-h3 mb-3 flex items-center">
                  <span className="text-xl mr-2">⚡</span>
                  Structure-from-Motion Engine
                </h4>
                <div className="grid md:grid-cols-1 gap-4">
                  <div>
                    <div className="flex gap-4">
                      <label className={`flex-1 border-2 p-4 cursor-pointer transition-all ${config.sfm_engine === 'glomap'
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
                            <span className="font-bold text-green-700 text-lg">🚀 {getSfmEngineLabel('glomap')}</span>
                            <span className="ml-2 px-2 py-0.5 bg-green-500 text-white text-xs rounded-full">RECOMMENDED</span>
                          </div>
                          <span className="text-green-600 font-semibold">Global SfM</span>
                        </div>
                        <p className="text-sm text-gray-600 mt-2">
                          COLMAP Global SfM - processes the sparse model globally instead of registering images one by one.
                          <strong className="text-green-700"> Best for most unordered photo sets.</strong>
                        </p>
                        <p className="text-xs text-green-600 mt-1">✓ Good for wide photo collections ✓ Faster than incremental on many datasets ✓ Keeps compatibility with legacy glomap alias</p>
                      </label>

                      <label className={`flex-1 border-2 p-4 cursor-pointer transition-all ${config.sfm_engine === 'fastmap'
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
                          First-order SfM optimized for GPU-first throughput.
                          <strong className="text-purple-700"> Best for dense video or capture streams where speed matters most.</strong>
                        </p>
                        <p className="text-xs text-purple-600 mt-1">✓ GPU-native ✓ Dense coverage ⚠️ Less robust</p>
                      </label>

                      <label className={`flex-1 border-2 p-4 cursor-pointer transition-all ${config.sfm_engine === 'colmap'
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
                          Incremental SfM - registers images one by one and can recover more cautiously from hard inputs.
                          <strong className="text-blue-700"> Best when you want step-by-step control or conservative fallback behavior.</strong>
                        </p>
                        <p className="text-xs text-blue-600 mt-1">✓ Battle-tested ✓ Handles edge cases ✓ More options</p>
                      </label>
                    </div>

                    {config.sfm_engine === 'fastmap' && (
                      <div className="mt-3 border border-[color:var(--ink)] bg-yellow-50 p-3">
                        <p className="text-sm text-yellow-800">
                          <strong>⚠️ FastMap Notice:</strong> Best for video frames with dense scene coverage. 
                          May fail on sparse photo collections or low-quality images. 
                          Use COLMAP Global SfM or COLMAP Incremental for more robust results.
                        </p>
                      </div>
                    )}

                    {usesGlobalSfm && (
                      <div className="mt-3 border border-[color:var(--ink)] bg-white px-4 py-3">
                        <p className="brutal-label mb-2">Global SfM Backend</p>
                        <select
                          value={config.sfm_backend}
                          onChange={(e) => setConfig({ ...config, sfm_backend: e.target.value as SfmBackendMode })}
                          className="brutal-select"
                        >
                          <option value="cli">CLI Global Mapper (Recommended)</option>
                          <option value="pycolmap">pycolmap.global_mapping (Experimental)</option>
                        </select>
                        <p className="mt-2 text-xs text-gray-600">
                          `pycolmap` is experimental here. The backend will try Python global mapping first, then fall back to the CLI global mapper automatically if the installed `pycolmap` is missing or too old.
                        </p>
                      </div>
                    )}

                    <div className="mt-3 border border-[color:var(--ink)] bg-emerald-50 px-4 py-3">
                      <p className="text-sm text-emerald-900">
                        <strong>Dynamic reconstruction framework:</strong> {engineRecommendation}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

                  {/* Feature Extraction Method Selection */}
              <div className="brutal-card-muted p-3 md:p-4 text-left">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="brutal-h3 flex items-center">
                    <span className="mr-2">🔬</span>
                    Feature Extraction Method
                    <span className="ml-2 text-xs bg-cyan-100 text-cyan-700 px-2 py-1 rounded-full">ULTRA SPEED</span>
                  </h4>
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  Neural features (ALIKED/SuperPoint) can substantially reduce matching cost versus traditional SIFT on high-resolution images
                </p>
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-3">
                    <label className={`flex-1 min-w-[200px] border-2 p-4 cursor-pointer transition-all ${config.feature_method === 'aliked'
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
                          <p className="text-xs text-gray-500 mt-1">Native neural features inside COLMAP</p>
                          <p className="text-xs text-cyan-600 mt-1">+ Native COLMAP LightGlue matching</p>
                        </div>
                      </div>
                    </label>
                    <label className={`flex-1 min-w-[200px] border-2 p-4 cursor-pointer transition-all ${config.feature_method === 'superpoint'
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
                    <label className={`flex-1 min-w-[200px] border-2 p-4 cursor-pointer transition-all ${config.feature_method === 'sift'
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
                    <div className="mt-3 border border-[color:var(--ink)] bg-cyan-50 p-3">
                      <p className="text-sm text-cyan-800">
                        <strong>🚀 Neural Features:</strong> {config.feature_method === 'aliked'
                          ? 'Using native COLMAP ALIKED + LightGlue inside the standard reconstruction pipeline.'
                          : 'Using hloc SuperPoint + LightGlue, then importing the results into the COLMAP database.'}
                        {' '}This is aimed at stronger high-resolution matching coverage than the classic SIFT path.
                      </p>
                    </div>
                  )}
                </div>
              </div>

                  {/* Resolution Settings */}
                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <p className="brutal-label mb-2">COLMAP Resolution</p>
                      <select
                        value={config.colmap_resolution}
                        onChange={(e) => setConfig({ ...config, colmap_resolution: e.target.value })}
                        className="brutal-select"
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
                      <p className="brutal-label mb-2">Training Resolution</p>
                      <select
                        value={config.training_resolution}
                        onChange={(e) => setConfig({ ...config, training_resolution: e.target.value })}
                        className="brutal-select"
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
                    <div className="border border-[color:var(--ink)] bg-gradient-to-r from-yellow-50 to-orange-50 p-3">
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
                    <div className="border border-[color:var(--ink)] bg-gradient-to-r from-yellow-50 to-orange-50 p-3">
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
                  <div className="brutal-card-muted p-3 md:p-4 text-left">
                    <h4 className="brutal-h3 mb-3 flex items-center">
                      <span className="text-xl mr-2">🧩</span>
                      8K Optimization (Patch-based Training)
                    </h4>
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <p className="brutal-label mb-2">Crop Size (pixels)</p>
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
                        <p className="text-xs text-gray-500 mt-1">
                          0 = Use full image | 512-1024 = Recommended for 8K images
                        </p>
                      </div>
                      <div className="flex items-center">
                          <div className="border border-[color:var(--ink)] bg-white p-3">
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
                      <p className="brutal-label mb-2">Feature Matching</p>
                      <select
                        value={config.matcher_type}
                        onChange={(e) => setConfig({ ...config, matcher_type: e.target.value as MatcherMode })}
                        className="brutal-select"
                      >
                        <option value="auto">Auto (Recommended, backend decides)</option>
                        <option value="sequential">Sequential (Ordered sequences / video)</option>
                        <option value="exhaustive">Exhaustive (Smaller unordered photo sets)</option>
                        <option value="vocab_tree">Vocabulary Tree (Experimental, large unordered photo sets)</option>
                      </select>
                      <p className="mt-2 text-xs text-gray-500">{matcherRecommendation}</p>
                    </div>
                    <div>
                      <p className="brutal-label mb-2">Camera Model</p>
                      <select
                        value={config.camera_model}
                        onChange={(e) => setConfig({ ...config, camera_model: e.target.value })}
                        className="brutal-select"
                      >
                        <option value="SIMPLE_RADIAL">SIMPLE_RADIAL (Recommended)</option>
                        <option value="SIMPLE_PINHOLE">SIMPLE_PINHOLE</option>
                        <option value="PINHOLE">PINHOLE</option>
                        <option value="OPENCV">OPENCV</option>
                      </select>
                    </div>
                  </div>
                  {hasVideo && (
                    <div className="mt-3">
                      <p className="brutal-label mb-2">Adaptive Pair Scheduling</p>
                      <label className="flex items-center justify-between cursor-pointer border border-[color:var(--ink)] bg-gradient-to-r from-amber-50 to-orange-50 p-3">
                        <div className="flex items-center">
                          <Zap className="h-5 w-5 text-amber-600 mr-2" />
                          <div>
                            <span className="font-medium text-gray-900">Expand sequential matching in checkpoints</span>
                            <p className="text-xs text-gray-600">เริ่มจาก pass เบาก่อน แล้วค่อยขยาย overlap/loop เฉพาะเมื่อ pair geometry ยังอ่อน</p>
                          </div>
                        </div>
                        <div className="relative">
                          <input
                            type="checkbox"
                            checked={config.adaptive_pair_scheduling}
                            onChange={(e) => setConfig({ ...config, adaptive_pair_scheduling: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:bg-amber-500 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                        </div>
                      </label>
                    </div>
                  )}

                  {/* Video Options */}
                  {hasVideo && (
                    <div className="brutal-card-muted p-3 md:p-4 text-left">
                      <h4 className="brutal-h3 mb-3 flex items-center">
                        <FileVideo className="h-5 w-5 mr-2" />
                        Video Frame Extraction Settings
                      </h4>
                      <div className="grid md:grid-cols-2 gap-4">
                        <div>
                          <p className="brutal-label mb-2">Extraction Mode</p>
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
                            <div>
                              <p className="brutal-label mb-2">Maximum Frames</p>
                              <input
                                type="number"
                                value={config.max_frames}
                                onChange={(e) => setConfig({ ...config, max_frames: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                min="1"
                                step="1"
                                className="brutal-input"
                              />
                              <p className="mt-1 text-xs text-gray-500">โหมดเดิม: จำกัดจำนวนภาพสูงสุด แล้ว backend อาจตัดทอนเพิ่มเติมภายหลัง</p>
                            </div>
                          ) : config.extraction_mode === 'target_count' ? (
                            <div>
                              <p className="brutal-label mb-2">Target Frame Count</p>
                              <input
                                type="number"
                                value={config.max_frames}
                                onChange={(e) => setConfig({ ...config, max_frames: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                min="1"
                                step="1"
                                className="brutal-input"
                                placeholder="เช่น 150 / 200 / 300"
                              />
                              <p className="mt-1 text-xs text-gray-500">ระบบจะคำนวณ spacing ตามความยาววิดีโอให้เอง แต่คงจำนวนภาพปลายทางให้ตรงเลขนี้แบบ FPS-style</p>
                            </div>
                          ) : (
                            <div>
                              <p className="brutal-label mb-2">Target FPS</p>
                              <select
                                value={config.target_fps}
                                onChange={(e) => setConfig({ ...config, target_fps: parseFloat(e.target.value) })}
                                className="brutal-select"
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
                      <div className="mt-3 border border-[color:var(--ink)] bg-gradient-to-r from-purple-50 to-indigo-50 p-3">
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
                      <div className="mt-3">
                        <p className="brutal-label mb-2">Oversample And Select</p>
                        <label className="flex items-center justify-between cursor-pointer border border-[color:var(--ink)] bg-gradient-to-r from-sky-50 to-cyan-50 p-3">
                          <div className="flex items-center">
                            <Image className="h-5 w-5 text-sky-600 mr-2" />
                            <div>
                              <span className="font-medium text-gray-900">Keep sharper frames after dense extraction</span>
                              <p className="text-xs text-gray-600">Extract a denser candidate pool first, then keep the sharpest frames at the requested FPS/count</p>
                            </div>
                          </div>
                          <div className="relative">
                            <input
                              type="checkbox"
                              checked={config.smart_frame_selection}
                              onChange={(e) => setConfig({ ...config, smart_frame_selection: e.target.checked })}
                              className="sr-only peer"
                            />
                            <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:bg-sky-500 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                          </div>
                        </label>
                      </div>
                      <div className="mt-3">
                        <p className="brutal-label mb-2">Adaptive Frame Budget</p>
                        <label className="flex items-center justify-between cursor-pointer border border-[color:var(--ink)] bg-gradient-to-r from-emerald-50 to-lime-50 p-3">
                          <div className="flex items-center">
                            <Zap className="h-5 w-5 text-emerald-600 mr-2" />
                            <div>
                              <span className="font-medium text-gray-900">Let the backend tighten or widen candidate density</span>
                              <p className="text-xs text-gray-600">ดูจาก duration, fps, resolution, bitrate, และ preview quality เพื่อไม่ให้ใช้ทรัพยากรหนักเกินโดยไม่จำเป็น</p>
                            </div>
                          </div>
                          <div className="relative">
                            <input
                              type="checkbox"
                              checked={config.adaptive_frame_budget}
                              onChange={(e) => setConfig({ ...config, adaptive_frame_budget: e.target.checked })}
                              disabled={!config.smart_frame_selection}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 rounded-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all ${config.smart_frame_selection ? 'bg-gray-200 peer-checked:bg-emerald-500 peer-checked:after:translate-x-full' : 'bg-gray-100 opacity-60'}`}></div>
                          </div>
                        </label>
                        {!config.smart_frame_selection && (
                          <p className="mt-1 text-xs text-gray-500">เปิดได้เมื่อใช้ oversample-and-select เท่านั้น</p>
                        )}
                      </div>
                      <div className="mt-3">
                        <p className="brutal-label mb-2">CPU Chunk Workers</p>
                        <select
                          value={config.ffmpeg_cpu_workers}
                          onChange={(e) => setConfig({ ...config, ffmpeg_cpu_workers: parseInt(e.target.value, 10) })}
                          className="brutal-select"
                        >
                          <option value={2}>2 workers</option>
                          <option value={4}>4 workers - Recommended</option>
                          <option value={8}>8 workers</option>
                        </select>
                        <p className="mt-1 text-xs text-gray-500">
                          กำหนดจำนวน process ที่ใช้แบ่งวิดีโอเป็น chunk แล้วถอดภาพพร้อมกัน ค่าเยอะขึ้นจะใช้ CPU และ RAM มากขึ้น
                        </p>
                      </div>
                      <div className="mt-3">
                        <p className="brutal-label mb-2">Oversample Factor</p>
                        <select
                          value={config.oversample_factor}
                          onChange={(e) => setConfig({ ...config, oversample_factor: parseInt(e.target.value, 10) || 10 })}
                          className="brutal-select"
                          disabled={!config.smart_frame_selection}
                        >
                          <option value={5}>5x</option>
                          <option value={10}>10x - Recommended</option>
                          <option value={15}>15x</option>
                          <option value={20}>20x</option>
                        </select>
                        <p className="mt-1 text-xs text-gray-500">
                          ถ้าเปิดโหมดนี้ ระบบจะถอด candidate ให้ถี่ขึ้นก่อนประมาณ {estimatedCandidatePool} แล้วค่อยคัดกลับให้เหลือเท่าค่าเป้าหมาย
                        </p>
                      </div>
                      <div className="mt-3">
                        <p className="brutal-label mb-2">Minimum Search Radius</p>
                        <select
                          value={config.replacement_search_radius}
                          onChange={(e) => setConfig({ ...config, replacement_search_radius: parseInt(e.target.value) || 4 })}
                          className="brutal-select"
                          disabled={!config.smart_frame_selection}
                        >
                          <option value={2}>±2 frames</option>
                          <option value={4}>±4 frames - Recommended</option>
                          <option value={6}>±6 frames</option>
                          <option value={8}>±8 frames</option>
                          <option value={12}>±12 frames</option>
                        </select>
                        <p className="mt-1 text-xs text-gray-500">
                          ใช้เป็นค่าขั้นต่ำของช่วงค้นหา และ backend จะขยายเพิ่มตาม spacing จริงเมื่อจำเป็น ตอนนี้คาดว่าจะค้นหา {estimatedSearchWindow}
                        </p>
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
                              <p className="brutal-label mb-1 cursor-help">
                                Training Iterations
                              </p>
                              <input
                                type="number"
                                value={customParams.iterations}
                                onChange={(e) => setCustomParams({ ...customParams, iterations: parseInt(e.target.value) || 7000 })}
                                min="100"
                                max="50000"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Better quality but slower (7000)</p>
                            </div>
                            <div title="ค่าเกณฑ์การเพิ่ม Gaussian splats - ต่ำกว่า = splats หนาแน่นกว่า = รายละเอียดมากขึ้น">
                              <p className="brutal-label mb-1 cursor-help">
                                Densify Grad Threshold
                              </p>
                              <input
                                type="number"
                                value={customParams.densify_grad_threshold}
                                onChange={(e) => setCustomParams({ ...customParams, densify_grad_threshold: parseFloat(e.target.value) || 0.00015 })}
                                min="0.00001"
                                max="0.001"
                                step="0.00001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Denser splats, more detail (0.00015)</p>
                            </div>
                            <div title="ความถี่การปรับแต่ง Gaussians - น้อยกว่า = ปรับบ่อยขึ้น = ละเอียดกว่า">
                              <p className="brutal-label mb-1 cursor-help">
                                Refine Every (steps)
                              </p>
                              <input
                                type="number"
                                value={customParams.refine_every}
                                onChange={(e) => setCustomParams({ ...customParams, refine_every: parseInt(e.target.value) || 75 })}
                                min="10"
                                max="500"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More frequent refinement (75)</p>
                            </div>
                            <div title="ระยะ warmup ของ learning rate - ยาวขึ้น = training เสถียรกว่า">
                              <p className="brutal-label mb-1 cursor-help">
                                Warmup Length
                              </p>
                              <input
                                type="number"
                                value={customParams.warmup_length}
                                onChange={(e) => setCustomParams({ ...customParams, warmup_length: parseInt(e.target.value) || 750 })}
                                min="100"
                                max="2000"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More stable training (750)</p>
                            </div>
                            <div title="น้ำหนักของ SSIM loss - สูงขึ้น = รักษาโครงสร้างได้ดีกว่า">
                              <p className="brutal-label mb-1 cursor-help">
                                SSIM Weight
                              </p>
                              <input
                                type="number"
                                value={customParams.ssim_weight}
                                onChange={(e) => setCustomParams({ ...customParams, ssim_weight: parseFloat(e.target.value) || 0.25 })}
                                min="0"
                                max="1"
                                step="0.01"
                                className="brutal-input"
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
                              <p className="brutal-label mb-1 cursor-help">
                                Learning Rate
                              </p>
                              <input
                                type="number"
                                value={customParams.learning_rate}
                                onChange={(e) => setCustomParams({ ...customParams, learning_rate: parseFloat(e.target.value) || 0.0025 })}
                                min="0.0001"
                                max="0.01"
                                step="0.0001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More stable training (0.0025)</p>
                            </div>
                            <div title="Initial position learning rate">
                              <p className="brutal-label mb-1 cursor-help">
                                Position LR Init
                              </p>
                              <input
                                type="number"
                                value={customParams.position_lr_init}
                                onChange={(e) => setCustomParams({ ...customParams, position_lr_init: parseFloat(e.target.value) || 0.00016 })}
                                min="0.00001"
                                max="0.001"
                                step="0.00001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Starting position LR (0.00016)</p>
                            </div>
                            <div title="Final position learning rate">
                              <p className="brutal-label mb-1 cursor-help">
                                Position LR Final
                              </p>
                              <input
                                type="number"
                                value={customParams.position_lr_final}
                                onChange={(e) => setCustomParams({ ...customParams, position_lr_final: parseFloat(e.target.value) || 0.0000016 })}
                                min="0.0000001"
                                max="0.0001"
                                step="0.0000001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Ending position LR (0.0000016)</p>
                            </div>
                            <div title="Feature learning rate">
                              <p className="brutal-label mb-1 cursor-help">
                                Feature LR
                              </p>
                              <input
                                type="number"
                                value={customParams.feature_lr}
                                onChange={(e) => setCustomParams({ ...customParams, feature_lr: parseFloat(e.target.value) || 0.0025 })}
                                min="0.0001"
                                max="0.01"
                                step="0.0001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Feature learning rate (0.0025)</p>
                            </div>
                            <div title="Opacity learning rate">
                              <p className="brutal-label mb-1 cursor-help">
                                Opacity LR
                              </p>
                              <input
                                type="number"
                                value={customParams.opacity_lr}
                                onChange={(e) => setCustomParams({ ...customParams, opacity_lr: parseFloat(e.target.value) || 0.05 })}
                                min="0.001"
                                max="0.5"
                                step="0.001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Opacity LR (0.05)</p>
                            </div>
                            <div title="Scaling learning rate">
                              <p className="brutal-label mb-1 cursor-help">
                                Scaling LR
                              </p>
                              <input
                                type="number"
                                value={customParams.scaling_lr}
                                onChange={(e) => setCustomParams({ ...customParams, scaling_lr: parseFloat(e.target.value) || 0.005 })}
                                min="0.0001"
                                max="0.05"
                                step="0.0001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Scaling LR (0.005)</p>
                            </div>
                            <div title="Rotation learning rate">
                              <p className="brutal-label mb-1 cursor-help">
                                Rotation LR
                              </p>
                              <input
                                type="number"
                                value={customParams.rotation_lr}
                                onChange={(e) => setCustomParams({ ...customParams, rotation_lr: parseFloat(e.target.value) || 0.001 })}
                                min="0.0001"
                                max="0.01"
                                step="0.0001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Rotation LR (0.001)</p>
                            </div>
                            <div title="Percentage of dense points">
                              <p className="brutal-label mb-1 cursor-help">
                                Percent Dense
                              </p>
                              <input
                                type="number"
                                value={customParams.percent_dense}
                                onChange={(e) => setCustomParams({ ...customParams, percent_dense: parseFloat(e.target.value) || 0.01 })}
                                min="0.001"
                                max="0.5"
                                step="0.001"
                                className="brutal-input"
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
                              <p className="brutal-label mb-1 cursor-help">
                                Peak Threshold
                              </p>
                              <input
                                type="number"
                                value={customParams.peak_threshold}
                                onChange={(e) => setCustomParams({ ...customParams, peak_threshold: parseFloat(e.target.value) || 0.01 })}
                                min="0.001"
                                max="0.1"
                                step="0.001"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More robust features (0.01)</p>
                            </div>
                            <div title="SIFT edge threshold - สูงขึ้น = กรอง false edges ได้ดีกว่า">
                              <p className="brutal-label mb-1 cursor-help">
                                Edge Threshold
                              </p>
                              <input
                                type="number"
                                value={customParams.edge_threshold}
                                onChange={(e) => setCustomParams({ ...customParams, edge_threshold: parseFloat(e.target.value) || 15 })}
                                min="5"
                                max="30"
                                step="1"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Reduce false edges (15)</p>
                            </div>
                            <div title="จำนวน orientations ต่อ keypoint - มากขึ้น = รับรู้ได้หลากหลายกว่า">
                              <p className="brutal-label mb-1 cursor-help">
                                Max Num Orientations
                              </p>
                              <input
                                type="number"
                                value={customParams.max_num_orientations}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_orientations: parseInt(e.target.value) || 2 })}
                                min="1"
                                max="5"
                                className="brutal-input"
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
                              <p className="brutal-label mb-1 cursor-help">
                                Max Features per Image
                              </p>
                              <input
                                type="number"
                                value={customParams.max_num_features}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_features: parseInt(e.target.value) || 12288 })}
                                min="1024"
                                max="32768"
                                step="1024"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More feature points = Better coverage (12288)</p>
                            </div>
                            <div title="จำนวน match points สูงสุดต่อ image pair - มากขึ้น = การจับคู่แม่นยำกว่า">
                              <p className="brutal-label mb-1 cursor-help">
                                Max Matches per Pair
                              </p>
                              <input
                                type="number"
                                value={customParams.max_num_matches}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_matches: parseInt(e.target.value) || 32768 })}
                                min="4096"
                                max="65536"
                                step="4096"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">More accurate matching (32768)</p>
                            </div>
                            <div title="จำนวนภาพที่แต่ละภาพจะจับคู่ด้วย - มากขึ้น = connectivity ดีกว่า">
                              <p className="brutal-label mb-1 cursor-help">
                                Sequential Overlap
                              </p>
                              <input
                                type="number"
                                value={customParams.sequential_overlap}
                                onChange={(e) => setCustomParams({ ...customParams, sequential_overlap: parseInt(e.target.value) || 18 })}
                                min="5"
                                max="50"
                                className="brutal-input"
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
                              <p className="brutal-label mb-1 cursor-help">
                                Min Num Matches
                              </p>
                              <input
                                type="number"
                                value={customParams.min_num_matches}
                                onChange={(e) => setCustomParams({ ...customParams, min_num_matches: parseInt(e.target.value) || 16 })}
                                min="6"
                                max="50"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Accept weaker matches = More images registered (16)</p>
                            </div>
                            <div title="จำนวนโมเดลสูงสุดที่ลองสร้าง - มากขึ้น = โอกาสได้โมเดลที่ดีสูงขึ้น">
                              <p className="brutal-label mb-1 cursor-help">
                                Max Num Models
                              </p>
                              <input
                                type="number"
                                value={customParams.max_num_models}
                                onChange={(e) => setCustomParams({ ...customParams, max_num_models: parseInt(e.target.value) || 40 })}
                                min="5"
                                max="100"
                                className="brutal-input"
                              />
                              <p className="text-xs text-gray-500 mt-0.5">Try more models = Higher chance of good result (40)</p>
                            </div>
                            <div title="จำนวนครั้งที่ลอง initialize reconstruction - มากขึ้น = โอกาสสำเร็จสูงขึ้น">
                              <p className="brutal-label mb-1 cursor-help">
                                Init Num Trials
                              </p>
                              <input
                                type="number"
                                value={customParams.init_num_trials}
                                onChange={(e) => setCustomParams({ ...customParams, init_num_trials: parseInt(e.target.value) || 225 })}
                                min="50"
                                max="500"
                                className="brutal-input"
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
                <div className="brutal-card-muted p-3 md:p-4 text-left">
                  <h4 className="brutal-h3 mb-2 flex items-center gap-2">
                    <Info className="h-5 w-5 mr-2" />
                    Processing Requirements
                  </h4>
                  <ul className="space-y-1 text-sm font-medium text-[color:var(--text-secondary)]">
                  <li>• Minimum 10 images/frames required for 3D reconstruction</li>
                  <li>• Videos will be automatically converted to frames</li>
                  <li>• Feature matching defaults to Auto and uses the backend reconstruction framework for orbit/video safety</li>
                  <li>• Higher quality = longer processing time (30s-30m)</li>
                  <li>• Best results with good lighting and multiple angles</li>
                  <li>• Current input profile: {inputProfile}</li>
                  <li>• Estimated time: {getQualityInfo(config.quality_mode).time} for {config.quality_mode} quality</li>
                  {config.quality_mode === 'hard' && (
                    <li>• Hard mode uses a heavier COLMAP policy first, then leaves long training for a later retry</li>
                  )}
                </ul>
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
                  <span>
                    📤 {formatFileSize(uploadedBytes)} / {formatFileSize(totalSize)}
                  </span>
                  <span>
                    {uploadSpeed > 0 ? `⚡ ${formatFileSize(uploadSpeed)}/s` : '⏳ Starting...'}
                  </span>
                </div>
                <p className="text-center text-xs font-medium text-[color:var(--text-secondary)]">
                  {uploadProgress < 100
                    ? uploadSpeed > 0
                      ? `Estimated time: ~${Math.ceil((totalSize - uploadedBytes) / uploadSpeed)}s remaining`
                      : 'Calculating speed...'
                    : '✅ Upload complete! Processing will start automatically...'
                  }
                </p>
              </div>
            ) : (
              <div className="flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setFiles([])}
                  className="brutal-btn"
                >
                  Clear All
                </button>
                <button
                  type="button"
                  onClick={handleUpload}
                  className="brutal-btn brutal-btn-primary"
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
        <div className="mt-4 flex items-center gap-2 border border-[color:var(--ink)] p-3" style={{ background: 'var(--error-bg)', color: 'var(--error-text)', boxShadow: 'var(--shadow-sm)' }}>
          <AlertCircle className="h-5 w-5" />
          <p className="text-sm font-bold">{error}</p>
        </div>
      )}

          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="brutal-card p-4">
          <CheckCircle className="mb-2 h-8 w-8" style={{ color: 'var(--success-icon)' }} />
          <h3 className="brutal-h3">Step 1: Upload</h3>
          <p className="mt-1 text-sm font-medium text-[color:var(--text-secondary)]">Select your video or images</p>
        </div>
        <div className="brutal-card p-4">
          <CheckCircle className="mb-2 h-8 w-8" style={{ color: 'var(--success-icon)' }} />
          <h3 className="brutal-h3">Step 2: Process</h3>
          <p className="mt-1 text-sm font-medium text-[color:var(--text-secondary)]">AI reconstructs 3D model</p>
        </div>
        <div className="brutal-card p-4">
          <CheckCircle className="mb-2 h-8 w-8" style={{ color: 'var(--success-icon)' }} />
          <h3 className="brutal-h3">Step 3: View</h3>
          <p className="mt-1 text-sm font-medium text-[color:var(--text-secondary)]">Explore your 3D splat</p>
        </div>
          </div>
        </div>
      </section>
    </div>
  );
}
