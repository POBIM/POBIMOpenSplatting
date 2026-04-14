const GLOBAL_SFM_ENGINES = new Set(['glomap', 'global', 'global_mapper']);

const normalizeName = (value?: string | null) => (value || '').trim().toLowerCase();

export const isGlobalSfmEngine = (engine?: string | null) => GLOBAL_SFM_ENGINES.has(normalizeName(engine));

export const getSfmEngineLabel = (engine?: string | null) => {
  const normalized = normalizeName(engine);

  if (GLOBAL_SFM_ENGINES.has(normalized)) {
    return 'COLMAP Global SfM';
  }

  if (normalized === 'fastmap') {
    return 'FastMap';
  }

  if (normalized === 'colmap') {
    return 'COLMAP Incremental';
  }

  if (!normalized) {
    return 'COLMAP';
  }

  return engine || 'COLMAP';
};

export const getSfmEngineCompactLabel = (engine?: string | null) => {
  const normalized = normalizeName(engine);

  if (GLOBAL_SFM_ENGINES.has(normalized)) {
    return 'Global Mapper';
  }

  if (normalized === 'fastmap') {
    return 'FastMap';
  }

  if (normalized === 'colmap') {
    return 'COLMAP';
  }

  if (!normalized) {
    return 'COLMAP';
  }

  return engine || 'COLMAP';
};

export const getMatcherLabel = (matcher?: string | null) => {
  const normalized = normalizeName(matcher);

  if (normalized === 'sequential') {
    return 'Sequential';
  }

  if (normalized === 'exhaustive') {
    return 'Exhaustive';
  }

  if (normalized === 'vocab_tree' || normalized === 'vocabulary_tree' || normalized === 'vocabulary-tree') {
    return 'Vocabulary Tree';
  }

  if (normalized === 'auto') {
    return 'Auto';
  }

  if (!normalized) {
    return '--';
  }

  return matcher || '--';
};

export const getMatcherLabelWithMode = (matcher?: string | null) => {
  const normalized = normalizeName(matcher);

  if (normalized === 'vocab_tree' || normalized === 'vocabulary_tree' || normalized === 'vocabulary-tree') {
    return 'Vocabulary Tree (Experimental)';
  }

  return getMatcherLabel(matcher);
};
