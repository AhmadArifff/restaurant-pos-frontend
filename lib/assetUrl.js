const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '';

const getApiOrigin = () => {
  const normalizedBaseUrl = API_BASE_URL.replace(/\/+$/, '');
  if (!normalizedBaseUrl) return '';
  return normalizedBaseUrl.endsWith('/api')
    ? normalizedBaseUrl.slice(0, -4)
    : normalizedBaseUrl;
};

export const resolveAssetUrl = (value, fallback = '/images/assets/logo.png') => {
  const candidate = String(value || fallback || '').trim();
  if (!candidate) return '';

  if (
    candidate === '/images/branding/default-logo.png' ||
    candidate === '/images/branding/default-logo.svg' ||
    candidate === '/images/branding/default-favicon.ico' ||
    candidate === '/images/branding/default-favicon.svg'
  ) {
    return fallback;
  }

  if (/^(data:|blob:|https?:\/\/)/i.test(candidate)) return candidate;
  if (!candidate.startsWith('/')) {
    const looksLikeAssetPath = /[\\/]/.test(candidate) || /\.(avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp)(\?.*)?$/i.test(candidate);
    if (!looksLikeAssetPath) return fallback && fallback !== candidate ? resolveAssetUrl(fallback, '') : '';
    const origin = getApiOrigin();
    return origin ? `${origin}/${candidate.replace(/^\/+/, '')}` : `/${candidate.replace(/^\/+/, '')}`;
  }
  if (!candidate.startsWith('/images/')) return candidate;

  const origin = getApiOrigin();
  return origin ? `${origin}${candidate}` : candidate;
};
