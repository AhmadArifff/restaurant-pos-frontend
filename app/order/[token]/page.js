'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  createCustomerOrder,
  createTableSession,
  getActiveDiscountPrograms,
  getCustomerMenu,
  getCustomerOrder,
  getDiningTableByToken,
  getPublicPaymentMethods,
  getWebsiteSettings,
  previewDiscount,
  releaseTableSession,
  skipCustomerOrderReview,
  submitCustomerOrderReview,
  validateReviewVoucher,
} from '@/lib/api';
import CustomerPaymentPanel from '@/components/customer/CustomerPaymentPanel';
import PaymentMethodCard from '@/components/payment/PaymentMethodCard';
import { resolveAssetUrl } from '@/lib/assetUrl';
import { IMAGE_EXTENSIONS, acceptFromExtensions, getFileValidationError } from '@/lib/fileValidation';
import { formatIndonesianPhone, normalizeIndonesianPhoneForSubmit } from '@/lib/phoneFormat';

const statusSteps = [
  { key: 'pending', label: 'Menunggu Kasir', desc: 'Pesanan sudah masuk ke dashboard kasir.' },
  { key: 'accepted', label: 'Diterima', desc: 'Kasir/admin sudah menerima pesanan.' },
  { key: 'preparing', label: 'Sedang Disiapkan', desc: 'Menu sedang dibuat oleh tim.' },
  { key: 'ready', label: 'Siap Diantar', desc: 'Pesanan siap disajikan ke meja.' },
  { key: 'completed', label: 'Selesai', desc: 'Pesanan selesai. Silakan beri review.' },
];

const PENDING_VOUCHER_KEY = 'landing-campaign-voucher-code';

const formatRp = (value) => `Rp ${Number(value || 0).toLocaleString('id-ID')}`;

const formatDateTime = (value) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatPaymentTimeLeft = (value) => {
  if (!value) return '-';
  const seconds = Math.max(0, Math.floor((new Date(value).getTime() - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

const getItemProductId = (item) => Number(item?.product_id || item?.id);
const getItemSubtotal = (item) => Number(item?.subtotal || Number(item?.price || 0) * Number(item?.qty || 0));

const getDiscountedBundleItems = ({ sourceItems = [], bundleItems = [] }) => {
  const requirementByProduct = new Map(
    (bundleItems || [])
      .map((item) => [Number(item.product_id || item.id || item), Math.max(1, Number(item.qty || 1))])
      .filter(([id]) => id)
  );
  if (!requirementByProduct.size) return [];

  return (sourceItems || [])
    .filter((item) => requirementByProduct.has(getItemProductId(item)))
    .map((item) => ({
      id: item.id || item.product_id,
      name: item.product_name || item.name,
      qty: Number(item.qty || 0),
      subtotal: getItemSubtotal(item),
    }));
};

const getDiscountedScopeItems = ({ sourceItems = [], discountType, bundleItems = [], excludedProductIds = new Set() }) => {
  if (discountType === 'bundle') {
    return getDiscountedBundleItems({ sourceItems, bundleItems });
  }
  if (['voucher', 'review_reward'].includes(discountType)) {
    return (sourceItems || [])
      .filter((item) => !excludedProductIds.has(getItemProductId(item)))
      .map((item) => ({
        id: item.id || item.product_id,
        name: item.product_name || item.name,
        qty: Number(item.qty || 0),
        subtotal: getItemSubtotal(item),
      }));
  }
  return [];
};

const getDiscountScopeTitle = (discountType) => {
  if (discountType === 'bundle') return 'Menu paket yang mendapat diskon:';
  if (discountType === 'voucher') return 'Menu yang terkena kode voucher:';
  if (discountType === 'review_reward') return 'Menu yang terkena reward review:';
  return 'Menu yang mendapat diskon:';
};

const getDiscountCardClass = (discountType) => {
  if (discountType === 'bundle') {
    return 'border border-emerald-400/20 bg-emerald-500/10 text-emerald-100/90';
  }
  if (discountType === 'voucher') {
    return 'border border-sky-300/20 bg-sky-400/10 text-sky-100/90';
  }
  if (discountType === 'review_reward') {
    return 'border border-[#C9A84C]/20 bg-[#C9A84C]/10 text-[#F5EDD8]/90';
  }
  return 'border border-emerald-400/20 bg-emerald-500/10 text-emerald-100/90';
};

const getDiscountTitleClass = (discountType) => {
  if (discountType === 'bundle') return 'text-emerald-200';
  if (discountType === 'voucher') return 'text-sky-100';
  if (discountType === 'review_reward') return 'text-[#C9A84C]';
  return 'text-emerald-200';
};

const getDiscountNote = (component) => {
  if (component.type === 'bundle') return 'Note: Potongan paket bundle hanya dihitung dari menu paket di atas.';
  if (component.type === 'voucher') return 'Note: Potongan Kode Vocher dihitung dari menu di luar paket bundle.';
  if (component.type === 'review_reward') return 'Note: Voucher review didapat dari review pesanan sebelumnya, dihitung dari menu di luar paket bundle, dan hanya bisa digunakan sekali.';
  return 'Note: Potongan diskon dihitung sesuai scope program.';
};

const getReviewVoucherDiscountText = (voucher) => {
  if (!voucher) return '';
  return voucher.discount_type === 'fixed'
    ? formatRp(voucher.discount_value)
    : `${Number(voucher.discount_value || 0)}%`;
};

const getReviewVoucherPayload = (voucher) => (
  voucher?.qr_payload || JSON.stringify({ type: 'review_reward_voucher', token: voucher?.token || '' })
);

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const decodeQrFromImageFile = async (file) => {
  const dataUrl = await fileToDataUrl(file);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const qr = jsQR(imageData.data, imageData.width, imageData.height);
  if (!qr?.data) throw new Error('QR voucher review tidak terbaca');
  return qr.data;
};

const calculateProgramDiscountAmount = (base, program) => {
  const discountValue = Number(program?.discount_value || 0);
  if (!base || !discountValue) return 0;
  if (program?.discount_type === 'fixed') return Math.min(Number(base), discountValue);
  return Number(base) * (discountValue / 100);
};

const getBundleDiscountBase = (program, sourceItems = []) => {
  const bundleIds = new Set((program?.bundleProducts || []).map((product) => Number(product.id)).filter(Boolean));
  return (sourceItems || []).reduce((sum, item) => (
    bundleIds.has(getItemProductId(item)) ? sum + getItemSubtotal(item) : sum
  ), 0);
};

const normalizeDiscountBreakdown = (discount) => {
  if (!discount) return [];
  if (Array.isArray(discount.breakdown) && discount.breakdown.length) return discount.breakdown;
  if (Number(discount.discount_amount || 0) <= 0) return [];
  return [{
    program_id: discount.program_id || discount.discount_program_id,
    label: discount.label || discount.discount_label,
    type: discount.type || discount.discount_program_type,
    discount_rate: discount.discount_rate,
    discount_amount: discount.discount_amount,
    discount_base: discount.discount_base || discount.subtotal,
    voucher_code: discount.voucher_code,
    bundle_items: discount.bundle_items || discount.discount_bundle_items || [],
  }];
};

const getBundleExcludedIds = (breakdown = []) => new Set(
  breakdown
    .filter((item) => item.type === 'bundle')
    .flatMap((item) => item.bundle_items || [])
    .map((item) => Number(item.product_id || item.id || item))
    .filter(Boolean)
);

const getProductIngredientNames = (product) => {
  const recipeItems = product?.ingredients || product?.recipe || product?.product_ingredients || [];
  if (Array.isArray(recipeItems) && recipeItems.length) {
    return recipeItems
      .map((item) => item?.stock_item_name || item?.ingredient_name || item?.name || item?.stock_name || '')
      .map((name) => String(name || '').trim())
      .filter(Boolean);
  }

  return String(product?.description || '')
    .split(',')
    .map((item) => item
      .replace(/\s+\d+([.,]\d+)?\s*(gram|gr|ml|pcs|porsi|buah|butir|sachet|kg|liter|ltr|cup)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
};

function StarPicker({ value = 5, onChange }) {
  const rating = Number(value || 0);
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Pilih rating bintang">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          className={`text-2xl leading-none transition hover:scale-110 ${star <= rating ? 'text-[#C9A84C]' : 'text-[#EDE0C4]/25'}`}
          aria-label={`${star} bintang`}
        >
          {star <= rating ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

const loadImage = (src) => new Promise((resolve, reject) => {
  if (!src) {
    reject(new Error('empty-image'));
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

function ReviewVoucherCard({ voucher, order, onClose, storeLogoUrl, storeName = 'Sultan Kebab' }) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const discountText = getReviewVoucherDiscountText(voucher);
  const customerName = voucher?.customer_name || order?.customer_name || 'Pelanggan Sultan';
  const orderDate = voucher?.source_order_date || voucher?.issued_at || order?.created_at;
  const payload = getReviewVoucherPayload(voucher);
  const logoUrl = resolveAssetUrl(storeLogoUrl, '/images/assets/logo.png');

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(payload, {
      width: 260,
      margin: 1,
      color: { dark: '#0D0A06', light: '#FFFFFF' },
    }).then((url) => {
      if (active) setQrDataUrl(url);
    }).catch(() => {});
    return () => { active = false; };
  }, [payload]);

  const downloadVoucher = async () => {
    if (!voucher?.token || !qrDataUrl) return;
    const canvas = document.createElement('canvas');
    canvas.width = 1120;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#1A1409');
    gradient.addColorStop(0.45, '#2B210F');
    gradient.addColorStop(1, '#0D0A06');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(201,168,76,0.65)';
    ctx.lineWidth = 5;
    ctx.strokeRect(36, 36, canvas.width - 72, canvas.height - 72);

    ctx.fillStyle = '#C9A84C';
    ctx.font = '700 34px Arial';
    ctx.fillText('SULTAN KEBAB', 80, 112);
    ctx.font = '900 82px Arial';
    ctx.fillText(`${discountText} OFF`, 80, 230);

    ctx.fillStyle = '#F5EDD8';
    ctx.font = '700 34px Arial';
    ctx.fillText(customerName, 80, 330);
    ctx.font = '24px Arial';
    ctx.fillStyle = 'rgba(245,237,216,0.78)';
    ctx.fillText(`Order review: ${voucher?.source_order_code || order?.order_code || '-'}`, 80, 380);
    ctx.fillText(`Tanggal: ${formatDateTime(orderDate)}`, 80, 424);
    ctx.fillText(`Expired: ${formatDateTime(voucher?.expires_at)}`, 80, 468);
    ctx.fillText('Upload gambar voucher ini saat order berikutnya untuk klaim.', 80, 540);

    const [qrImage, logoImage] = await Promise.all([
      loadImage(qrDataUrl),
      loadImage(logoUrl).catch(() => null),
    ]);
    if (logoImage) {
      ctx.save();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(790, 76, 92, 92);
      ctx.drawImage(logoImage, 800, 86, 72, 72);
      ctx.restore();
      ctx.fillStyle = '#F5EDD8';
      ctx.font = '700 22px Arial';
      ctx.fillText(storeName, 900, 128);
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(790, 150, 250, 250);
    ctx.drawImage(qrImage, 805, 165, 220, 220);
    ctx.fillStyle = '#C9A84C';
    ctx.font = '700 22px Arial';
    ctx.fillText(voucher.token, 785, 450);

    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `voucher-review-${voucher.token}.png`;
    link.click();
  };

  if (!voucher) return null;

  return (
    <motion.div
      className="fixed inset-x-3 bottom-4 z-[110] mx-auto max-h-[92vh] max-w-xl overflow-y-auto rounded-[2rem] border border-[#C9A84C]/30 bg-[#0D0A06] p-4 text-[#F5EDD8] shadow-2xl shadow-black/70 sm:inset-x-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
    >
      <div className="rounded-[1.6rem] border border-[#C9A84C]/35 bg-[linear-gradient(135deg,#1A1409,#2A210F_48%,#0D0A06)] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.28em] text-[#C9A84C]">Voucher Review</p>
            <h2 className="mt-2 text-4xl font-black text-[#F5EDD8]">{discountText}</h2>
            <p className="mt-1 text-sm text-[#EDE0C4]/70">Untuk pesanan berikutnya</p>
          </div>
          <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-[#C9A84C]/25 bg-white/95 p-1">
            <img
              src={logoUrl}
              alt={storeName}
              className="h-full w-full object-contain"
              onError={(event) => {
                event.currentTarget.src = '/images/assets/logo.png';
              }}
            />
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_170px]">
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#C9A84C]">Nama pelanggan</p>
              <p className="mt-1 text-lg font-black">{customerName}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#C9A84C]">Tanggal pesanan</p>
              <p className="mt-1">{formatDateTime(orderDate)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#C9A84C]">Expired</p>
              <p className="mt-1">{formatDateTime(voucher.expires_at)}</p>
            </div>
            <div className="rounded-2xl bg-black/25 p-3">
              <p className="text-xs leading-5 text-[#EDE0C4]/75">
                Cara klaim: simpan/download voucher ini, lalu pada pesanan berikutnya upload gambar voucher di kolom voucher review. Sistem akan scan QR dan mencocokkan nama serta nomor HP pemilik voucher.
              </p>
            </div>
          </div>
          <div className="rounded-3xl bg-white p-3">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="QR voucher review" className="h-full w-full object-contain" />
            ) : (
              <div className="grid aspect-square place-items-center text-sm font-bold text-[#0D0A06]">Memuat QR</div>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={downloadVoucher}
          className="rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black text-[#0D0A06]"
        >
          Download Voucher
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-sm font-black text-[#C9A84C]"
        >
          Tutup
        </button>
      </div>
    </motion.div>
  );
}

export default function CustomerOrderPage() {
  const params = useParams();
  const router = useRouter();
  const token = params?.token;
  const storageKey = token ? `customer-order-${token}` : '';
  const draftStorageKey = token ? `customer-order-draft-${token}` : '';
  const phoneStorageKey = token ? `customer-order-phone-${token}` : '';
  const tableSessionStorageKey = token ? `customer-table-session-${token}` : '';
  const paymentSectionRef = useRef(null);

  const [table, setTable] = useState(null);
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('+62');
  const [voucherCode, setVoucherCode] = useState('');
  const [reviewVoucherToken, setReviewVoucherToken] = useState('');
  const [reviewVoucherValidation, setReviewVoucherValidation] = useState(null);
  const [reviewVoucherScanning, setReviewVoucherScanning] = useState(false);
  const [note, setNote] = useState('');
  const [order, setOrder] = useState(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [review, setReview] = useState({ service_rating: 5, service_comment: '', items: {} });
  const [discountAlert, setDiscountAlert] = useState(null);
  const [showMobileCart, setShowMobileCart] = useState(false);
  const [reviewRewardProgram, setReviewRewardProgram] = useState(null);
  const [bundlePrograms, setBundlePrograms] = useState([]);
  const [discountPreview, setDiscountPreview] = useState(null);
  const [discountLoading, setDiscountLoading] = useState(false);
  const [bundlePrompt, setBundlePrompt] = useState(null);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState('');
  const [paymentConfirmOrder, setPaymentConfirmOrder] = useState(null);
  const [storeSettings, setStoreSettings] = useState(null);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [reviewPromptSeenForOrder, setReviewPromptSeenForOrder] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [skipReviewLoading, setSkipReviewLoading] = useState(false);
  const [orderMessageModal, setOrderMessageModal] = useState(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [tableSession, setTableSession] = useState(null);
  const [leaveCartConfirmOpen, setLeaveCartConfirmOpen] = useState(false);
  const [reviewVoucherModal, setReviewVoucherModal] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productDetailFlipped, setProductDetailFlipped] = useState(false);
  const cartRef = useRef([]);
  const orderRef = useRef(null);
  const discountPreviewRef = useRef(null);
  const sessionTouchRef = useRef({ inFlight: null, lastTouchedAt: 0 });
  const customerPhoneForApi = normalizeIndonesianPhoneForSubmit(customerPhone);

  useEffect(() => { cartRef.current = cart; }, [cart]);
  useEffect(() => { orderRef.current = order; }, [order]);
  useEffect(() => { discountPreviewRef.current = discountPreview; }, [discountPreview]);

  useEffect(() => {
    if (!token) return;
    let mounted = true;

    const load = async () => {
      const savedOrderCode = storageKey ? localStorage.getItem(storageKey) : null;
      const savedOrderPhone = phoneStorageKey ? localStorage.getItem(phoneStorageKey) : '';
      const pendingCampaignVoucher = String(localStorage.getItem(PENDING_VOUCHER_KEY) || '').trim().toUpperCase();
      const savedDraft = (() => {
        if (!draftStorageKey) return null;
        try {
          return JSON.parse(localStorage.getItem(draftStorageKey) || 'null');
        } catch (_) {
          return null;
        }
      })();
      const savedDraftHasCart = Array.isArray(savedDraft?.cart) && savedDraft.cart.length > 0;
      const existingSessionToken = tableSessionStorageKey ? localStorage.getItem(tableSessionStorageKey) || '' : '';
      const savedCustomerPhone = savedDraft?.customerPhone || savedOrderPhone || '';
      const tableRes = await getDiningTableByToken(token, {
        session_token: existingSessionToken,
        customer_phone: normalizeIndonesianPhoneForSubmit(savedCustomerPhone),
      });
      const tableLockedByOtherCustomer = Number(tableRes.data?.active_orders || 0) > 0
        && !savedOrderCode
        && !savedDraftHasCart;
      if (tableLockedByOtherCustomer) {
        if (!mounted) return;
        if (tableSessionStorageKey) localStorage.removeItem(tableSessionStorageKey);
        setTable(tableRes.data);
        setDraftLoaded(true);
        setLoading(false);
        router.replace('/order');
        return;
      }
      const [menuRes, rewardRes, bundleRes, paymentRes, settingsRes, orderRes] = await Promise.all([
        getCustomerMenu({ branch_id: tableRes.data?.branch_id }),
        getActiveDiscountPrograms({ type: 'review_reward' }).catch(() => ({ data: [] })),
        getActiveDiscountPrograms({ type: 'bundle' }).catch(() => ({ data: [] })),
        getPublicPaymentMethods().catch(() => ({ data: [] })),
        getWebsiteSettings().catch(() => ({ data: null })),
        savedOrderCode ? getCustomerOrder(savedOrderCode).catch(() => null) : Promise.resolve(null),
      ]);
      if (!mounted) return;
      setTable(tableRes.data);
      setProducts(menuRes.data || []);
      setReviewRewardProgram(Array.isArray(rewardRes.data) ? rewardRes.data[0] || null : null);
      setBundlePrograms(Array.isArray(bundleRes.data) ? bundleRes.data : []);
      const activePayments = Array.isArray(paymentRes.data) ? paymentRes.data : [];
      setPaymentMethods(activePayments);
      setStoreSettings(settingsRes?.data || null);
      setSelectedPaymentMethodId((prev) => prev || String(savedDraft?.selectedPaymentMethodId || activePayments[0]?.id || ''));
      if (orderRes?.data) {
        setOrder(orderRes.data);
        const rememberedPhone = orderRes.data.customer_phone || savedOrderPhone;
        if (rememberedPhone) setCustomerPhone(formatIndonesianPhone(rememberedPhone));
      } else if (savedDraft) {
        const menuIds = new Set((menuRes.data || []).map((product) => Number(product.id)));
        setCart(Array.isArray(savedDraft.cart) ? savedDraft.cart.filter((item) => menuIds.has(Number(item.id))) : []);
        setCustomerName(savedDraft.customerName || '');
        setCustomerPhone(savedDraft.customerPhone || '+62');
        setVoucherCode(savedDraft.voucherCode || pendingCampaignVoucher || '');
        setReviewVoucherToken(savedDraft.reviewVoucherToken || '');
        setReviewVoucherValidation(savedDraft.reviewVoucherValidation || null);
        setNote(savedDraft.note || '');
      } else if (!orderRes?.data && pendingCampaignVoucher) {
        setVoucherCode(pendingCampaignVoucher);
      }
      if (!orderRes?.data && !savedDraftHasCart && existingSessionToken) {
        await releaseTableSession(existingSessionToken).catch(() => {});
        localStorage.removeItem(tableSessionStorageKey);
        setTableSession(null);
      }
      if (!orderRes?.data && tableSessionStorageKey && savedDraftHasCart) {
        const sessionRes = await createTableSession(token, { session_token: existingSessionToken }).catch((err) => {
          localStorage.removeItem(tableSessionStorageKey);
          throw err;
        });
        const session = sessionRes.data?.data;
        if (session?.session_token) {
          localStorage.setItem(tableSessionStorageKey, session.session_token);
          setTableSession(session);
        }
      }
      setDraftLoaded(true);
      setLoading(false);
    };

    load().catch(() => mounted && setLoading(false));

    return () => {
      mounted = false;
    };
  }, [token, storageKey, draftStorageKey, phoneStorageKey, tableSessionStorageKey, router]);

  useEffect(() => {
    if (!draftLoaded || !draftStorageKey || order) return;
    const hasDraft = cart.length > 0;

    if (!hasDraft) {
      localStorage.removeItem(draftStorageKey);
      return;
    }

    localStorage.setItem(draftStorageKey, JSON.stringify({
      updated_at: new Date().toISOString(),
      cart,
      customerName,
      customerPhone,
      voucherCode,
      reviewVoucherToken,
      reviewVoucherValidation,
      note,
      selectedPaymentMethodId,
    }));
  }, [cart, customerName, customerPhone, voucherCode, reviewVoucherToken, reviewVoucherValidation, note, selectedPaymentMethodId, draftLoaded, draftStorageKey, order]);

  useEffect(() => {
    if (!order?.order_code || order.status === 'completed' || order.status === 'cancelled') return;

    const interval = window.setInterval(() => {
      getCustomerOrder(order.order_code)
        .then((res) => setOrder(res.data))
        .catch(() => {});
    }, 6000);

    return () => window.clearInterval(interval);
  }, [order?.order_code, order?.status]);

  useEffect(() => {
    if (!order?.order_code || order.status !== 'completed' || order.reviewed_at || order.review_skipped_at) return;
    const completedAt = order.completed_at ? new Date(order.completed_at).getTime() : Date.now();
    const stillInReviewWindow = Date.now() - completedAt <= 60 * 60 * 1000;
    if (!stillInReviewWindow || reviewPromptSeenForOrder === order.order_code) return;
    setReviewPromptSeenForOrder(order.order_code);
    setReviewModalOpen(true);
  }, [order?.order_code, order?.status, order?.reviewed_at, order?.review_skipped_at, order?.completed_at, reviewPromptSeenForOrder]);

  useEffect(() => {
    if (!token || order) return;
    const interval = window.setInterval(() => {
      getDiningTableByToken(token, {
        session_token: tableSessionStorageKey ? localStorage.getItem(tableSessionStorageKey) || '' : '',
        customer_phone: customerPhoneForApi,
      })
        .then((res) => setTable(res.data))
        .catch(() => {});
    }, 20000);
    return () => window.clearInterval(interval);
  }, [token, order, tableSessionStorageKey, customerPhoneForApi]);

  useEffect(() => {
    if (!tableSession?.expires_at || order) return;
    const timeout = new Date(tableSession.expires_at).getTime() - Date.now();
    if (timeout <= 0) {
      if (tableSessionStorageKey) localStorage.removeItem(tableSessionStorageKey);
      router.push('/order');
      return;
    }
    const timer = window.setTimeout(() => {
      if (tableSessionStorageKey) localStorage.removeItem(tableSessionStorageKey);
      router.push('/order');
    }, timeout);
    return () => window.clearTimeout(timer);
  }, [tableSession?.expires_at, tableSessionStorageKey, order, router]);

  useEffect(() => {
    if (!token || order) return undefined;
    window.history.pushState({ customerOrderGuard: true }, '', window.location.href);
    const onPopState = () => {
      if (orderRef.current) {
        router.push('/order');
        return;
      }
      if (cartRef.current.length > 0) {
        window.history.pushState({ customerOrderGuard: true }, '', window.location.href);
        setLeaveCartConfirmOpen(true);
        return;
      }
      leaveToTableList();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [token, order]);

  const categories = useMemo(() => {
    const map = new Map();
    products.forEach((product) => {
      if (product.category_id) map.set(String(product.category_id), product.category_name || 'Menu');
    });
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [products]);

  const filteredProducts = useMemo(() => products
    .filter((product) => activeCategory === 'all' || String(product.category_id) === String(activeCategory))
    .sort((a, b) => {
      const stockA = Number(a.stock || 0);
      const stockB = Number(b.stock || 0);
      const availableA = stockA > 0 ? 1 : 0;
      const availableB = stockB > 0 ? 1 : 0;
      if (availableA !== availableB) return availableB - availableA;
      if (stockA !== stockB) return stockB - stockA;
      return String(a.name || '').localeCompare(String(b.name || ''), 'id');
    }), [products, activeCategory]);

  const total = cart.reduce((sum, item) => sum + Number(item.price) * item.qty, 0);
  const itemCount = cart.reduce((sum, item) => sum + item.qty, 0);
  const discountAmount = Math.max(0, Number(discountPreview?.discount_amount || 0));
  const payableTotal = Math.max(0, Number(discountPreview?.final_total ?? total));
  const previewBreakdown = normalizeDiscountBreakdown(discountPreview);
  const previewBundleExcludedIds = getBundleExcludedIds(previewBreakdown);
  const previewDiscountBreakdown = previewBreakdown.map((component) => ({
    ...component,
    scopeItems: getDiscountedScopeItems({
      sourceItems: cart,
      discountType: component.type,
      bundleItems: component.bundle_items || [],
      excludedProductIds: component.type === 'bundle' ? new Set() : previewBundleExcludedIds,
    }),
  }));
  const orderBreakdown = normalizeDiscountBreakdown(order ? {
    ...order,
    breakdown: order.discount_breakdown,
    type: order.discount_program_type,
    bundle_items: order.discount_bundle_items,
  } : null);
  const orderBundleExcludedIds = getBundleExcludedIds(orderBreakdown);
  const orderDiscountBreakdown = orderBreakdown.map((component) => ({
    ...component,
    scopeItems: getDiscountedScopeItems({
      sourceItems: order?.items || [],
      discountType: component.type,
      bundleItems: component.bundle_items || [],
      excludedProductIds: component.type === 'bundle' ? new Set() : orderBundleExcludedIds,
    }),
  }));
  const selectedPaymentMethod = paymentMethods.find((method) => String(method.id) === String(selectedPaymentMethodId));
  const visibleStatusSteps = order?.status === 'cancelled'
    ? [{ key: 'cancelled', label: 'Dibatalkan', desc: order.cancel_reason || 'Pesanan dibatalkan.' }]
    : statusSteps;
  const canOrderAgain = order?.status === 'cancelled' || order?.status === 'completed';
  const tableBusy = !order && Number(table?.active_orders || 0) > 0;
  const branchLabel = table?.branch_name || 'Cabang Sultan Kebab';
  const branchArea = table?.branch_area || table?.branch_address || '';
  const reviewRewardText = reviewRewardProgram
    ? `Review semua menu dan dapatkan voucher diskon ${
        reviewRewardProgram.discount_type === 'percent'
          ? `${Number(reviewRewardProgram.discount_value || 0)}%`
          : formatRp(reviewRewardProgram.discount_value)
      }`
    : 'Review semua menu';
  const reviewVoucherInfo = reviewRewardProgram
    ? `${reviewRewardText}. Voucher hanya diberikan jika rating memenuhi syarat dan kuota masih tersedia.`
    : 'Program voucher review sedang tidak aktif. Review tetap membantu kami memperbaiki pelayanan.';

  const bundleHints = useMemo(() => {
    const productById = new Map(products.map((product) => [Number(product.id), product]));
    const cartQtyById = new Map();
    cart.forEach((item) => {
      const productId = Number(item.id || item.product_id);
      if (!productId) return;
      cartQtyById.set(productId, Number(cartQtyById.get(productId) || 0) + Number(item.qty || 0));
    });

    return (bundlePrograms || [])
      .map((program) => {
        const bundleItems = Array.isArray(program.bundle_items) && program.bundle_items.length
          ? program.bundle_items
          : (program.bundle_product_ids || []).map((id) => ({ product_id: id, qty: 1 }));
        const uniqueBundleItems = [...new Map(bundleItems
          .map((item) => [Number(item.product_id || item.id || item), {
            product_id: Number(item.product_id || item.id || item),
            qty: Math.max(1, Number(item.qty || 1)),
          }])
          .filter(([id]) => id)).values()];
        const bundleProducts = uniqueBundleItems.map((item) => ({
          ...productById.get(Number(item.product_id)),
          required_qty: Number(item.qty || 1),
          current_qty: Number(cartQtyById.get(Number(item.product_id)) || 0),
        })).filter((product) => product.id);
        if (bundleProducts.length === 0) return null;

        const missingProducts = bundleProducts.filter((product) => Number(product.current_qty || 0) < Number(product.required_qty || 1));
        const selectedCount = bundleProducts.length - missingProducts.length;
        const unavailable = missingProducts.filter((product) => Number(product.stock || 0) < Number(product.required_qty || 1));
        const discountText = program.discount_type === 'percent'
          ? `${Number(program.discount_value || 0)}%`
          : formatRp(program.discount_value);

        return {
          ...program,
          bundleProducts,
          missingProducts,
          selectedCount,
          unavailable,
          discountText,
          complete: missingProducts.length === 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.selectedCount) - Number(a.selectedCount));
  }, [bundlePrograms, cart, products]);

  const qualifiedBundleAlternatives = useMemo(() => bundleHints
    .filter((program) => program.complete)
    .map((program) => {
      const discountBase = getBundleDiscountBase(program, cart);
      const discountAmountValue = calculateProgramDiscountAmount(discountBase, program);
      return {
        ...program,
        discountBase,
        discountAmountValue,
      };
    })
    .filter((program) => program.discountAmountValue > 0)
    .sort((a, b) => Number(b.discountAmountValue) - Number(a.discountAmountValue)), [bundleHints, cart]);

  const touchTableSession = async () => {
    if (!token || order || !tableSessionStorageKey) return null;
    const sessionToken = localStorage.getItem(tableSessionStorageKey) || tableSession?.session_token || '';
    const expiresAt = tableSession?.expires_at ? new Date(tableSession.expires_at).getTime() : 0;
    const hasFreshSession = sessionToken && expiresAt - Date.now() > 2 * 60 * 1000;
    if (hasFreshSession) return tableSession;
    if (sessionTouchRef.current.inFlight) return sessionTouchRef.current.inFlight;
    if (Date.now() - sessionTouchRef.current.lastTouchedAt < 1200) return null;

    sessionTouchRef.current.lastTouchedAt = Date.now();
    sessionTouchRef.current.inFlight = (async () => {
      try {
        const res = await createTableSession(token, {
          session_token: sessionToken,
          customer_phone: customerPhoneForApi,
        });
        const session = res.data?.data;
        if (session?.session_token) {
          localStorage.setItem(tableSessionStorageKey, session.session_token);
          setTableSession(session);
        }
        return session;
      } catch (_) {
        return null;
      } finally {
        sessionTouchRef.current.inFlight = null;
      }
    })();

    try {
      return await sessionTouchRef.current.inFlight;
    } catch (_) {
      return null;
    }
  };

  const ensureCartTableSession = async () => {
    if (!token || order || !tableSessionStorageKey) return false;
    const currentSessionToken = localStorage.getItem(tableSessionStorageKey) || tableSession?.session_token || '';
    if (currentSessionToken) return true;

    const session = await touchTableSession();
    if (session?.session_token || localStorage.getItem(tableSessionStorageKey)) return true;

    setOrderMessageModal({
      title: 'Meja sedang dipakai',
      message: 'Meja ini baru saja aktif di perangkat lain. Silakan pilih meja lain atau hubungi kasir.',
      tone: 'warning',
    });
    return false;
  };

  const releaseCurrentTableSession = async () => {
    const sessionToken = tableSessionStorageKey ? localStorage.getItem(tableSessionStorageKey) || '' : '';
    if (sessionToken) await releaseTableSession(sessionToken).catch(() => {});
    if (tableSessionStorageKey) localStorage.removeItem(tableSessionStorageKey);
    sessionTouchRef.current = { inFlight: null, lastTouchedAt: 0 };
    setTableSession(null);
  };

  const leaveToTableList = async ({ clearCart = false } = {}) => {
    if (clearCart) {
      setCart([]);
      if (draftStorageKey) localStorage.removeItem(draftStorageKey);
    }
    if (!orderRef.current) await releaseCurrentTableSession();
    router.push('/order');
  };

  const requestLeaveToTableList = () => {
    if (!order && cart.length > 0) {
      setLeaveCartConfirmOpen(true);
      return;
    }
    leaveToTableList();
  };

  useEffect(() => {
    if (!draftLoaded || order || cart.length > 0 || !tableSessionStorageKey) return;
    const sessionToken = localStorage.getItem(tableSessionStorageKey) || '';
    if (!sessionToken) return;
    releaseCurrentTableSession();
  }, [cart.length, draftLoaded, order, tableSessionStorageKey]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (!cart.length || total <= 0) {
        setDiscountPreview(null);
        return;
      }

      try {
        if (!discountPreviewRef.current) setDiscountLoading(true);
        const res = await previewDiscount({
          subtotal: total,
          items: cart.map((item) => ({ product_id: item.id, qty: item.qty, price: item.price })),
          customer_phone: customerPhoneForApi,
          customer_name: customerName,
          voucher_code: voucherCode,
          review_voucher_token: reviewVoucherToken,
        });
        if (!cancelled) setDiscountPreview(res.data?.applicable ? res.data : null);
      } catch (err) {
        if (!cancelled) {
          setDiscountPreview({
            applicable: false,
            error: true,
            message: err.response?.data?.message || 'Diskon belum bisa digunakan.',
          });
        }
      } finally {
        if (!cancelled) setDiscountLoading(false);
      }
    }, 650);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cart, customerName, customerPhoneForApi, total, voucherCode, reviewVoucherToken]);

  const addToCart = async (product) => {
    if (tableBusy) return;
    if (Number(product.stock || 0) <= 0) return;
    if (!cartRef.current.length || !localStorage.getItem(tableSessionStorageKey)) {
      const sessionReady = await ensureCartTableSession();
      if (!sessionReady) return;
    }
    setCart((prev) => {
      const existing = prev.find((item) => item.id === product.id);
      if (existing) {
        if (existing.qty >= Number(product.stock || 0)) return prev;
        return prev.map((item) => item.id === product.id ? { ...item, qty: item.qty + 1 } : item);
      }
      return [...prev, { ...product, qty: 1, note: '' }];
    });
  };

  const addBundleToCart = async (program) => {
    if (tableBusy) return;
    if (!cartRef.current.length || !localStorage.getItem(tableSessionStorageKey)) {
      const sessionReady = await ensureCartTableSession();
      if (!sessionReady) return;
    }
    const targets = (program.missingProducts?.length ? program.missingProducts : program.bundleProducts)
      .filter((product) => Number(product.stock || 0) > 0);
    if (!targets.length) return;

    setCart((prev) => {
      let next = prev;
      targets.forEach((product) => {
        const existing = next.find((item) => item.id === product.id);
        const needed = Math.max(1, Number(product.required_qty || 1) - Number(existing?.qty || product.current_qty || 0));
        if (existing) {
          next = next.map((item) => item.id === product.id ? { ...item, qty: item.qty + needed } : item);
          return;
        }
        next = [...next, { ...product, qty: needed, note: '' }];
      });
      return next;
    });
    setShowMobileCart(true);
  };

  const buildCartWithBundle = (program) => {
    let next = [...cart];
    (program.missingProducts || []).forEach((product) => {
      if (Number(product.stock || 0) <= 0) return;
      const existing = next.find((item) => item.id === product.id);
      const needed = Math.max(1, Number(product.required_qty || 1) - Number(existing?.qty || product.current_qty || 0));
      if (existing) {
        next = next.map((item) => item.id === product.id ? { ...item, qty: item.qty + needed } : item);
      } else {
        next = [...next, { ...product, qty: needed, note: '' }];
      }
    });
    return next;
  };

  const changeQty = (productId, delta) => {
    if (!cartRef.current.length || !localStorage.getItem(tableSessionStorageKey)) touchTableSession();
    setCart((prev) => prev
      .map((item) => item.id === productId ? { ...item, qty: Math.max(0, item.qty + delta) } : item)
      .filter((item) => item.qty > 0));
  };

  const startNewOrder = async () => {
    const repeatCustomerPhone = order?.customer_phone || customerPhoneForApi || customerPhone;
    if (storageKey) localStorage.removeItem(storageKey);
    if (draftStorageKey) localStorage.removeItem(draftStorageKey);
    if (phoneStorageKey && repeatCustomerPhone) localStorage.setItem(phoneStorageKey, repeatCustomerPhone);
    setOrder(null);
    setCart([]);
    setVoucherCode('');
    setReviewVoucherToken('');
    setReviewVoucherValidation(null);
    setReviewVoucherModal(null);
    setNote('');
    setDiscountAlert(null);
    setDiscountPreview(null);
    setBundlePrompt(null);
    setPaymentConfirmOrder(null);
    setReviewModalOpen(false);
    setReview({ service_rating: 5, service_comment: '', items: {} });
    setShowMobileCart(false);

    try {
      if (token) {
        const tableRes = await getDiningTableByToken(token, {
          session_token: tableSessionStorageKey ? localStorage.getItem(tableSessionStorageKey) || '' : '',
          customer_phone: normalizeIndonesianPhoneForSubmit(repeatCustomerPhone),
        });
        setTable(tableRes.data);
        const menuRes = await getCustomerMenu({ branch_id: tableRes.data?.branch_id });
        setProducts(menuRes.data || []);
      }
    } catch (_) {}

    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const submitOrderWithCart = async (orderCart) => {
    if (tableBusy) {
      setOrderMessageModal({
        title: 'Meja masih aktif',
        message: 'Meja ini masih memiliki pesanan aktif. Silakan hubungi kasir atau pilih meja lain.',
        tone: 'warning',
      });
      return;
    }
    if (!orderCart.length) {
      setOrderMessageModal({
        title: 'Keranjang kosong',
        message: 'Pilih menu terlebih dahulu sebelum mengirim pesanan.',
        tone: 'warning',
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await createCustomerOrder({
        table_token: token,
        table_session_token: tableSessionStorageKey ? localStorage.getItem(tableSessionStorageKey) || tableSession?.session_token || '' : '',
        customer_name: customerName,
        customer_phone: customerPhoneForApi,
        voucher_code: voucherCode,
        review_voucher_token: reviewVoucherToken,
        payment_method_id: selectedPaymentMethodId || null,
        note,
        items: orderCart.map((item) => ({ product_id: item.id, qty: item.qty, note: item.note || null })),
      });
      const nextOrder = res.data.data;
      setOrder(nextOrder);
      setCart([]);
      setShowMobileCart(false);
      if (nextOrder?.payment_method) setPaymentConfirmOrder(nextOrder);
      if (storageKey) localStorage.setItem(storageKey, nextOrder.order_code);
      if (phoneStorageKey && customerPhoneForApi) localStorage.setItem(phoneStorageKey, customerPhoneForApi);
      localStorage.removeItem(PENDING_VOUCHER_KEY);
      if (tableSessionStorageKey) localStorage.removeItem(tableSessionStorageKey);
      if (draftStorageKey) localStorage.removeItem(draftStorageKey);
    } catch (err) {
      setOrderMessageModal({
        title: 'Pesanan gagal dikirim',
        message: err.response?.data?.message || 'Gagal mengirim pesanan. Silakan coba lagi.',
        tone: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const submitOrder = async () => {
    const candidate = bundleHints.find((program) => (
      !program.complete
      && program.selectedCount > 0
      && program.missingProducts?.length
      && program.unavailable.length === 0
    ));
    if (candidate) {
      setBundlePrompt(candidate);
      return;
    }
    await submitOrderWithCart(cart);
  };

  const confirmBundleAndSubmit = async () => {
    if (!bundlePrompt) return;
    const nextCart = buildCartWithBundle(bundlePrompt);
    setCart(nextCart);
    setBundlePrompt(null);
    setShowMobileCart(true);
  };

  const scrollToPayment = () => {
    setPaymentConfirmOrder(null);
    window.setTimeout(() => {
      paymentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  };

  const submitReview = async () => {
    const savedOrderPhone = phoneStorageKey ? localStorage.getItem(phoneStorageKey) : '';
    const reviewPhone = order?.customer_phone || savedOrderPhone || customerPhoneForApi;

    const itemReviews = (order?.items || []).map((item) => ({
      order_item_id: item.id,
      rating: Number(review.items[item.id]?.rating || 5),
      comment: review.items[item.id]?.comment || '',
    }));

    try {
      setReviewSubmitting(true);
      const res = await submitCustomerOrderReview(order.order_code, {
        service_rating: Number(review.service_rating || 5),
        service_comment: review.service_comment,
        customer_phone: reviewPhone,
        customer_name: order?.customer_name || customerName,
        items: itemReviews,
      });
      setOrder(res.data.data);
      setDiscountAlert(res.data);
      if (res.data.review_voucher || res.data.data?.review_voucher) {
        setReviewVoucherModal(res.data.review_voucher || res.data.data.review_voucher);
      }
      setReviewModalOpen(false);
    } catch (err) {
      setOrderMessageModal({
        title: 'Review gagal dikirim',
        message: err.response?.data?.message || 'Gagal mengirim review. Silakan coba lagi.',
        tone: 'danger',
      });
    } finally {
      setReviewSubmitting(false);
    }
  };

  const skipReview = async () => {
    if (!order?.order_code) return;
    try {
      setSkipReviewLoading(true);
      const res = await skipCustomerOrderReview(order.order_code);
      setOrder(res.data.data);
      setReviewModalOpen(false);
    } catch (err) {
      setOrderMessageModal({
        title: 'Review belum bisa dilewati',
        message: err.response?.data?.message || 'Gagal melewati review. Silakan coba lagi.',
        tone: 'danger',
      });
    } finally {
      setSkipReviewLoading(false);
    }
  };

  const handleReviewVoucherUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const validationError = getFileValidationError(file, {
        allowedExtensions: IMAGE_EXTENSIONS,
        label: 'gambar voucher review',
        maxSizeMB: 5,
      });
      if (validationError) {
        throw new Error(validationError);
      }
      setReviewVoucherScanning(true);
      setReviewVoucherValidation(null);
      const qrPayload = await decodeQrFromImageFile(file);
      const res = await validateReviewVoucher({
        token: qrPayload,
        customer_phone: customerPhoneForApi,
        customer_name: customerName,
      });
      const voucher = res.data?.data;
      setReviewVoucherToken(voucher?.token || qrPayload);
      setReviewVoucherValidation(voucher || null);
    } catch (err) {
      setReviewVoucherToken('');
      setReviewVoucherValidation(null);
      setOrderMessageModal({
        title: 'Voucher review tidak valid',
        message: err.response?.data?.message || err.message || 'QR voucher review tidak terbaca. Pastikan gambar voucher jelas dan data nama serta nomor HP sesuai.',
        tone: 'danger',
      });
    } finally {
      setReviewVoucherScanning(false);
    }
  };

  const pasteVoucherCode = async () => {
    const fallbackCode = typeof window === 'undefined'
      ? ''
      : String(localStorage.getItem(PENDING_VOUCHER_KEY) || '').trim().toUpperCase();
    try {
      const clipboardCode = await navigator.clipboard?.readText();
      const normalizedCode = String(clipboardCode || fallbackCode || '').trim().toUpperCase();
      if (normalizedCode) setVoucherCode(normalizedCode);
    } catch {
      if (fallbackCode) setVoucherCode(fallbackCode);
    }
  };

  const renderCartPanel = (isMobile = false) => (
    <motion.div
      key={isMobile ? 'mobile-cart' : 'cart'}
      initial={{ opacity: 0, x: isMobile ? 0 : 18, y: isMobile ? 18 : 0 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      exit={{ opacity: 0, x: isMobile ? 0 : 18, y: isMobile ? 18 : 0 }}
      className={`${isMobile ? 'rounded-t-3xl border-t' : 'rounded-[2rem] border'} border-[#C9A84C]/20 bg-[#1A1409] p-4 sm:p-5`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-[0.24em] text-[#C9A84C]">Keranjang Meja {table.table_number}</p>
          <h2 className="mt-2 text-2xl font-black">{itemCount} item</h2>
        </div>
        {isMobile && (
          <button
            type="button"
            onClick={() => setShowMobileCart(false)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[#C9A84C]/20 text-lg font-black text-[#C9A84C]"
            aria-label="Tutup keranjang"
          >
            x
          </button>
        )}
      </div>

      <div className={`${isMobile ? 'max-h-[34vh] overflow-y-auto pr-1' : ''} mt-5 space-y-3`}>
        {cart.length === 0 && <p className="rounded-3xl bg-[#241C0E] p-5 text-sm text-[#EDE0C4]/65">Belum ada menu dipilih.</p>}
        {cart.map((item) => (
          <div key={item.id} className="rounded-3xl bg-[#241C0E] p-4">
            <div className="flex justify-between gap-3">
              <div className="min-w-0">
                <p className="line-clamp-2 font-bold">{item.name}</p>
                <p className="text-sm text-[#C9A84C]">{formatRp(item.price)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => changeQty(item.id, -1)} className="h-8 w-8 rounded-full bg-[#1A1409] font-black">-</button>
                <span className="w-6 text-center font-black">{item.qty}</span>
                <button onClick={() => changeQty(item.id, 1)} className="h-8 w-8 rounded-full bg-[#C9A84C] font-black text-[#0D0A06]">+</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Nama pelanggan (opsional)" className="w-full rounded-2xl border border-[#C9A84C]/20 bg-[#0D0A06] px-4 py-3 outline-none" />
        <input value={customerPhone} onChange={(e) => setCustomerPhone(formatIndonesianPhone(e.target.value))} inputMode="numeric" placeholder="+62895-3530-25503" className="w-full rounded-2xl border border-[#C9A84C]/20 bg-[#0D0A06] px-4 py-3 outline-none" />
        <div className="flex gap-2">
          <input value={voucherCode} onChange={(e) => setVoucherCode(e.target.value.toUpperCase())} placeholder="Kode vocher / voucher (opsional)" className="min-w-0 flex-1 rounded-2xl border border-[#C9A84C]/20 bg-[#0D0A06] px-4 py-3 font-bold uppercase outline-none" />
          <button
            type="button"
            onClick={pasteVoucherCode}
            className="shrink-0 rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-[#C9A84C]"
          >
            Paste
          </button>
        </div>
        <div className="rounded-2xl border border-[#C9A84C]/20 bg-[#0D0A06] p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C9A84C]">Voucher Review QR</p>
              <p className="mt-1 text-xs leading-5 text-[#EDE0C4]/60">
                Upload gambar voucher review dari pesanan sebelumnya. Sistem scan QR, lalu mencocokkan nama dan nomor HP pemilik voucher.
              </p>
            </div>
            {reviewVoucherToken && (
              <button
                type="button"
                onClick={() => {
                  setReviewVoucherToken('');
                  setReviewVoucherValidation(null);
                }}
                className="shrink-0 rounded-full border border-red-300/25 px-3 py-1 text-xs font-black text-red-200"
              >
                Hapus
              </button>
            )}
          </div>
          <label className="mt-3 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-[#C9A84C]/30 px-4 py-3 text-sm font-black text-[#C9A84C]">
            {reviewVoucherScanning ? 'Scan QR...' : reviewVoucherToken ? 'Ganti gambar voucher' : 'Upload gambar voucher review'}
            <input
              type="file"
              accept={acceptFromExtensions(IMAGE_EXTENSIONS)}
              onChange={handleReviewVoucherUpload}
              className="hidden"
            />
          </label>
          {reviewVoucherValidation && (
            <div className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-500/10 p-3 text-xs leading-5 text-emerald-100">
              <p className="font-black">Voucher valid: {getReviewVoucherDiscountText(reviewVoucherValidation)} dari {reviewVoucherValidation.program_name || 'Reward Review'}</p>
              <p>Pemilik: {reviewVoucherValidation.customer_name || '-'} - {reviewVoucherValidation.customer_phone || '-'}</p>
              <p>Order asal: {reviewVoucherValidation.source_order_code || '-'} · Expired {formatDateTime(reviewVoucherValidation.expires_at)}</p>
            </div>
          )}
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan pesanan..." className="max-h-28 w-full rounded-2xl border border-[#C9A84C]/20 bg-[#0D0A06] px-4 py-3 outline-none" />
      </div>

      <div>
      {cart.length > 0 && (
        <div className="mt-5 rounded-3xl border border-[#C9A84C]/18 bg-[#241C0E] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C9A84C]">Metode pembayaran</p>
              <p className="mt-1 text-xs text-[#EDE0C4]/55">Pilih QRIS atau transfer sebelum kirim pesanan.</p>
            </div>
            {selectedPaymentMethod && (
              <span className="shrink-0 rounded-full bg-[#C9A84C]/12 px-3 py-1 text-[11px] font-black text-[#C9A84C]">
                {selectedPaymentMethod.type === 'transfer' ? 'Transfer' : 'QRIS'}
              </span>
            )}
          </div>
          {paymentMethods.length > 0 ? (
            <div className="mt-3 grid gap-3">
              {paymentMethods.map((method) => {
                const active = String(selectedPaymentMethodId) === String(method.id);
                return (
                  <PaymentMethodCard
                    key={method.id}
                    method={method}
                    active={active}
                    compact
                    className=""
                    onClick={() => setSelectedPaymentMethodId(String(method.id))}
                  />
                );
              })}
            </div>
          ) : (
            <p className="mt-2 text-sm leading-6 text-[#EDE0C4]/70">
              Metode pembayaran online belum diatur admin. Pesanan tetap bisa dikirim dan pelanggan dapat konfirmasi ke kasir.
            </p>
          )}
        </div>
      )}

        <div className="mt-5 border-t border-[#C9A84C]/15 pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-[#EDE0C4]/70">Subtotal</span>
            <strong className="text-2xl text-[#C9A84C]">{formatRp(total)}</strong>
          </div>
          {cart.length > 0 && (
            <div className="mt-3 rounded-2xl border border-[#C9A84C]/15 bg-[#0D0A06]/55 p-3 text-xs">
              {discountLoading ? (
                <p className="text-[#EDE0C4]/55">Mengecek diskon...</p>
              ) : discountPreview?.error ? (
                <p className="text-yellow-200">{discountPreview.message}</p>
              ) : discountAmount > 0 ? (
                <div className="space-y-2">
                  <div className="flex justify-between gap-3 text-[#F5EDD8]">
                    <span>{discountPreview.label}</span>
                    <strong className="text-red-300">-{formatRp(discountAmount)}</strong>
                  </div>
                  {previewDiscountBreakdown.map((component) => (
                    <div key={`${component.type}-${component.program_id || component.label}`} className={`rounded-xl p-2 text-[11px] leading-5 ${getDiscountCardClass(component.type)}`}>
                      <div className={`flex justify-between gap-2 font-black ${getDiscountTitleClass(component.type)}`}>
                        <span>{component.label}</span>
                        <span className="text-red-300">-{formatRp(component.discount_amount)}</span>
                      </div>
                      <p className="font-black">{getDiscountScopeTitle(component.type)}</p>
                      {component.scopeItems.map((item) => (
                        <p key={item.id}>{item.name} x{item.qty} - dasar {formatRp(item.subtotal)}</p>
                      ))}
                      <p className="mt-1 opacity-75">
                        {getDiscountNote(component)}
                        {component.type !== 'bundle' ? ` Dasar potongan ${formatRp(component.discount_base || 0)}.` : ''}
                      </p>
                    </div>
                  ))}
                  {!previewDiscountBreakdown.some((component) => component.type === 'bundle') && qualifiedBundleAlternatives.length > 0 && (
                    <div className="rounded-xl border border-[#C9A84C]/15 bg-[#C9A84C]/10 p-2 text-[11px] leading-5 text-[#F5EDD8]/85">
                      <p className="font-black text-[#C9A84C]">Paket bundle yang juga memenuhi syarat:</p>
                      {qualifiedBundleAlternatives.slice(0, 2).map((program) => (
                        <div key={program.id} className="mt-1">
                          <p className="font-bold">{program.name} - potensi potongan {formatRp(program.discountAmountValue)}</p>
                          <p className="text-[#EDE0C4]/65">
                            {program.bundleProducts.map((product) => `${product.name} x${product.current_qty || product.required_qty || 1}`).join(', ')}
                          </p>
                        </div>
                      ))}
                      <p className="mt-1 text-[#EDE0C4]/65">Paket bundle akan memotong menu paket saja, sedangkan voucher memotong menu di luar paket.</p>
                    </div>
                  )}
                  <div className="flex justify-between gap-3 border-t border-[#C9A84C]/10 pt-2 text-emerald-300">
                    <span>Total bayar</span>
                    <strong className="text-emerald-200">{formatRp(payableTotal)}</strong>
                  </div>
                </div>
              ) : bundleHints.some((program) => program.complete) && !customerPhoneForApi ? (
                <p className="text-yellow-200">Isi nomor HP agar diskon paket bundle bisa diklaim.</p>
              ) : bundleHints.some((program) => !program.complete && program.missingProducts?.length) ? (
                <p className="text-[#C9A84C]">
                  Tambah {bundleHints.find((program) => !program.complete && program.missingProducts?.length)?.missingProducts?.map((item) => `${item.name} x${Math.max(1, Number(item.required_qty || 1) - Number(item.current_qty || 0))}`).join(', ')} untuk membuka diskon paket.
                </p>
              ) : (
                <p className="text-[#EDE0C4]/55">Voucher dan paket bundle otomatis dicek sebelum pesanan dikirim.</p>
              )}
            </div>
          )}
        </div>
      </div>
      <button
        onClick={submitOrder}
        disabled={submitting || !cart.length}
        className="mt-4 w-full rounded-2xl bg-[#C9A84C] py-3 font-black uppercase tracking-[0.12em] text-[#0D0A06] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? 'Mengirim...' : 'Kirim Pesanan'}
      </button>
    </motion.div>
  );

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0D0A06] text-[#C9A84C]">
        <div className="h-12 w-12 animate-spin rounded-full border-2 border-[#C9A84C]/20 border-t-[#C9A84C]" />
      </main>
    );
  }

  if (!table) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0D0A06] p-6 text-center text-[#F5EDD8]">
        <div>
          <h1 className="font-serif text-4xl font-black">QR meja tidak aktif</h1>
          <p className="mt-3 text-[#EDE0C4]/70">Silakan pilih meja lain atau hubungi kasir.</p>
          <Link href="/order" className="mt-6 inline-flex rounded-2xl bg-[#C9A84C] px-5 py-3 font-bold text-[#0D0A06]">Pilih Meja</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#0D0A06] text-[#F5EDD8]">
      <header className="sticky top-0 z-40 border-b border-[#C9A84C]/15 bg-[#0D0A06]/92 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 overflow-hidden">
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-[0.28em] text-[#C9A84C]">Sultan Kebab</p>
            <h1 className="text-xl font-black">Meja {table.table_number}</h1>
            <p className="mt-1 max-w-[calc(100vw-150px)] truncate text-xs text-[#EDE0C4]/60 sm:max-w-none">{branchLabel}{branchArea ? ` - ${branchArea}` : ''}</p>
          </div>
          <button
            type="button"
            onClick={requestLeaveToTableList}
            className="shrink-0 rounded-full border border-[#C9A84C]/35 px-3 py-2 text-sm font-bold text-[#C9A84C]"
          >
            Ganti Meja
          </button>
        </div>
      </header>

      <div className={`mx-auto grid gap-5 px-3 pb-28 pt-4 sm:px-4 sm:py-6 lg:pb-6 ${
        order ? 'max-w-5xl lg:grid-cols-1' : 'max-w-7xl lg:grid-cols-[minmax(0,1fr)_380px]'
      }`}>
        <section className={order ? 'hidden' : 'min-w-0'}>
          <div className="mb-4 rounded-3xl border border-[#C9A84C]/18 bg-[#1A1409] p-4 sm:mb-5 sm:rounded-[2rem] sm:p-5">
            <p className="text-xs font-black uppercase tracking-[0.28em] text-[#C9A84C]">Pesan langsung dari meja</p>
            <h2 className="mt-2 font-serif text-2xl font-black sm:text-3xl">Pilih menu favorit Anda</h2>
            <p className="mt-2 text-sm leading-7 text-[#EDE0C4]/70">
              Pesanan akan masuk ke kasir, lalu statusnya bisa Anda pantau dari halaman ini.
            </p>
            <div className="mt-4 inline-flex max-w-full rounded-full border border-[#C9A84C]/25 bg-[#C9A84C]/10 px-4 py-2 text-xs font-bold text-[#F5EDD8]">
              Cabang: <span className="ml-1 text-[#C9A84C]">{branchLabel}</span>
            </div>
          </div>

          {tableBusy && (
            <div className="mb-5 rounded-3xl border border-yellow-400/25 bg-yellow-500/10 p-4 text-yellow-100">
              Meja ini masih memiliki pesanan aktif. Untuk mencegah double order, pemesanan baru dikunci sampai pesanan sebelumnya selesai atau dibatalkan.
            </div>
          )}

          <div className="sticky top-[73px] z-30 -mx-3 mb-4 flex gap-2 overflow-x-auto border-y border-[#C9A84C]/10 bg-[#0D0A06]/95 px-3 py-2 backdrop-blur sm:static sm:mx-0 sm:mb-5 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
            <button
              onClick={() => setActiveCategory('all')}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${activeCategory === 'all' ? 'bg-[#C9A84C] text-[#0D0A06]' : 'bg-[#1A1409] text-[#EDE0C4]'}`}
            >
              Semua
            </button>
            {categories.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold ${activeCategory === category.id ? 'bg-[#C9A84C] text-[#0D0A06]' : 'bg-[#1A1409] text-[#EDE0C4]'}`}
              >
                {category.name}
              </button>
            ))}
          </div>

          {!tableBusy && bundleHints.length > 0 && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              {bundleHints.map((program) => {
                const disabled = !program.complete && program.unavailable.length > 0;
                return (
                  <button
                    key={program.id}
                    type="button"
                    onClick={() => !disabled && !program.complete && addBundleToCart(program)}
                    disabled={disabled}
                    className={`rounded-3xl border p-4 text-left transition ${
                      program.complete
                        ? 'cursor-default border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
                        : disabled
                          ? 'cursor-not-allowed border-[#C9A84C]/10 bg-[#1A1409]/60 text-[#EDE0C4]/45'
                          : 'border-[#C9A84C]/30 bg-[#C9A84C]/10 text-[#F5EDD8] active:scale-[0.99]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#C9A84C]">Paket Bundle</p>
                        <h3 className="mt-1 line-clamp-2 font-black">{program.name}</h3>
                      </div>
                      <span className="shrink-0 rounded-full bg-[#0D0A06]/70 px-3 py-1 text-xs font-black text-[#C9A84C]">
                        {program.discountText}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[#EDE0C4]/70">
                      {program.complete
                        ? 'Syarat paket sudah lengkap. Isi nomor HP agar diskon bisa diklaim.'
                        : disabled
                          ? `Belum bisa diklaim karena ${program.unavailable.map((item) => item.name).join(', ')} sedang habis.`
                          : `Ambil ${program.missingProducts.map((item) => `${item.name} x${Math.max(1, Number(item.required_qty || 1) - Number(item.current_qty || 0))}`).join(', ')} untuk dapat diskon paket.`}
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 2xl:grid-cols-3">
            {filteredProducts.map((product, index) => {
              const soldOut = Number(product.stock || 0) <= 0 || tableBusy;
              const stockSource = product.stock_source_user?.user_name
                ? `Stok dari ${product.stock_source_user.user_name}`
                : 'Stok siap cabang';
              return (
                <motion.article
                  key={product.id}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.025 }}
                  onClick={() => {
                    setSelectedProduct(product);
                    setProductDetailFlipped(false);
                  }}
                  className="flex min-h-[150px] cursor-pointer overflow-hidden rounded-3xl border border-[#C9A84C]/16 bg-[#1A1409] transition hover:border-[#C9A84C]/35 sm:block sm:min-h-0 sm:rounded-[1.6rem]"
                >
                  <div className="h-[150px] w-20 shrink-0 overflow-hidden bg-[#241C0E] min-[380px]:w-24 sm:h-44 sm:w-full">
                    {product.image_url ? (
                      <img src={resolveAssetUrl(product.image_url)} alt={product.name} className="h-full w-full object-cover object-center" />
                    ) : (
                      <div className="grid h-full place-items-center text-5xl">K</div>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col p-3 sm:p-4">
                    <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
                      <div className="min-w-0">
                        <h3 className="line-clamp-2 text-base font-black leading-snug sm:text-lg">{product.name}</h3>
                        <p className="mt-1 text-sm text-[#EDE0C4]/58">{product.category_name || 'Menu'}</p>
                      </div>
                      <strong className="text-sm text-[#C9A84C] sm:shrink-0 sm:text-base">{formatRp(product.price)}</strong>
                    </div>
                    <div className="mt-auto flex flex-col items-start gap-2 pt-3 min-[380px]:flex-row min-[380px]:flex-wrap min-[380px]:items-center min-[380px]:justify-between sm:mt-4 sm:pt-0">
                      <span className={`max-w-full rounded-full px-2.5 py-1 text-xs font-bold ${soldOut ? 'bg-red-500/15 text-red-200' : 'bg-emerald-500/15 text-emerald-200'}`}>
                        {tableBusy ? 'Meja sedang aktif' : soldOut ? 'Stok habis' : `${product.stock} porsi siap`}
                      </span>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          addToCart(product);
                        }}
                        disabled={soldOut}
                        className="min-h-9 min-w-[86px] max-w-full shrink-0 rounded-xl bg-[#C9A84C] px-3 py-2 text-sm font-black text-[#0D0A06] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-10 sm:px-4"
                      >
                        Tambah
                      </button>
                    </div>
                    {!tableBusy && !soldOut && (
                      <p className="mt-2 text-xs font-semibold text-[#EDE0C4]/55">{stockSource}</p>
                    )}
                  </div>
                </motion.article>
              );
            })}
          </div>
        </section>

        <aside className={`${order ? '' : 'hidden lg:block'} ${order ? '' : 'lg:sticky lg:top-24'} lg:h-fit`}>
          <AnimatePresence mode="wait">
            {order ? (
              <motion.div
                key="order-status"
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 18 }}
                className="rounded-[2rem] border border-[#C9A84C]/20 bg-[#1A1409] p-5"
              >
                <p className="text-xs font-black uppercase tracking-[0.28em] text-[#C9A84C]">Riwayat Pesanan</p>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <h2 className="text-2xl font-black">{order.order_code}</h2>
                  <span className="rounded-full bg-[#C9A84C]/15 px-3 py-1 text-xs font-black uppercase text-[#C9A84C]">{order.status}</span>
                </div>

                <div className="mt-5 space-y-3">
                  {visibleStatusSteps.map((step, index) => {
                    const currentIndex = visibleStatusSteps.findIndex((item) => item.key === order.status);
                    const active = index <= currentIndex;
                    return (
                      <div key={step.key} className="flex gap-3">
                        <span className={`mt-1 h-4 w-4 rounded-full border ${active ? 'border-[#C9A84C] bg-[#C9A84C]' : 'border-[#C9A84C]/25'}`} />
                        <div>
                          <p className={`font-bold ${active ? 'text-[#F5EDD8]' : 'text-[#EDE0C4]/45'}`}>{step.label}</p>
                          <p className="text-xs leading-5 text-[#EDE0C4]/55">{step.desc}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {order.status === 'cancelled' && (
                  <div className="mt-5 rounded-3xl border border-red-400/25 bg-red-500/12 p-4 text-sm leading-6 text-red-100">
                    Pesanan ini sudah dibatalkan.
                    {order.cancel_reason && <p className="mt-1 text-red-100/75">{order.cancel_reason}</p>}
                  </div>
                )}

                <div className="mt-5 rounded-3xl bg-[#241C0E] p-4">
                  {order.items?.map((item) => (
                    <div key={item.id} className="flex justify-between gap-3 border-b border-[#C9A84C]/10 py-2 last:border-0">
                      <span className="text-sm">{item.product_name} x{item.qty}</span>
                      <strong className="text-sm text-[#C9A84C]">{formatRp(item.subtotal)}</strong>
                    </div>
                  ))}
                  <div className="mt-3 flex justify-between text-sm">
                    <span>Total</span>
                    <strong>{formatRp(order.final_total || order.subtotal)}</strong>
                  </div>
                  {Number(order.discount_amount || 0) > 0 && (
                  <div className="mt-1 flex justify-between text-xs text-[#F5EDD8]">
                    <span>{order.discount_label || `Diskon review ${order.discount_rate}%`}</span>
                    <strong className="text-red-300">-{formatRp(order.discount_amount)}</strong>
                  </div>
                )}
                  {orderDiscountBreakdown.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {orderDiscountBreakdown.map((component) => (
                        <div key={`${component.type}-${component.program_id || component.label}`} className={`rounded-2xl p-3 text-xs leading-5 ${getDiscountCardClass(component.type)}`}>
                          <div className={`flex justify-between gap-2 font-black ${getDiscountTitleClass(component.type)}`}>
                            <span>{component.label}</span>
                            <span className="text-red-300">-{formatRp(component.discount_amount)}</span>
                          </div>
                          <p className={`font-black ${getDiscountTitleClass(component.type)}`}>{getDiscountScopeTitle(component.type)}</p>
                          {component.scopeItems.map((item) => (
                            <p key={item.id}>{item.name} x{item.qty} - dasar {formatRp(item.subtotal)}</p>
                          ))}
                          <p className="mt-1 opacity-75">
                            {getDiscountNote(component)}
                            {component.type !== 'bundle' ? ` Dasar potongan ${formatRp(component.discount_base || 0)}.` : ''}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div ref={paymentSectionRef} className="scroll-mt-24">
                  <CustomerPaymentPanel order={order} onOrderUpdate={setOrder} compact />
                </div>

                {order.status === 'completed' && !order.reviewed_at && !order.review_skipped_at && (
                  <div className="mt-5 rounded-3xl border border-[#C9A84C]/20 bg-[#0D0A06]/55 p-4">
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-[#C9A84C]">Review Pesanan</p>
                    <p className="mt-2 text-sm leading-6 text-[#EDE0C4]/75">
                      Pesanan sudah selesai. Bantu review pelayanan dan menu yang Anda pesan.
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setReviewModalOpen(true)}
                        className="rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black text-[#0D0A06]"
                      >
                        Review Sekarang
                      </button>
                      <button
                        type="button"
                        onClick={skipReview}
                        disabled={skipReviewLoading}
                        className="rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-sm font-black text-[#C9A84C] disabled:opacity-50"
                      >
                        {skipReviewLoading ? 'Memproses...' : 'Lewati Review'}
                      </button>
                    </div>
                  </div>
                )}

                {discountAlert && (
                  <div className="mt-5 rounded-3xl border border-emerald-400/25 bg-emerald-500/12 p-4 text-sm text-emerald-100">
                    {discountAlert.review_voucher || order.review_voucher
                      ? 'Voucher review berhasil dibuat. Simpan voucher QR ini untuk klaim diskon di pesanan berikutnya.'
                      : discountAlert.message || 'Terima kasih atas review Anda.'}
                    {(discountAlert.review_voucher || order.review_voucher) && (
                      <button
                        type="button"
                        onClick={() => setReviewVoucherModal(discountAlert.review_voucher || order.review_voucher)}
                        className="mt-3 block rounded-xl bg-emerald-300 px-4 py-2 text-xs font-black text-emerald-950"
                      >
                        Lihat Voucher Review
                      </button>
                    )}
                  </div>
                )}

                {!discountAlert && order.review_voucher && (
                  <div className="mt-5 rounded-3xl border border-[#C9A84C]/25 bg-[#C9A84C]/10 p-4 text-sm text-[#F5EDD8]">
                    <p className="font-black text-[#C9A84C]">Voucher review tersedia</p>
                    <p className="mt-1 leading-6 text-[#EDE0C4]/75">
                      Gunakan voucher {getReviewVoucherDiscountText(order.review_voucher)} ini pada pesanan berikutnya dengan upload gambar voucher di keranjang.
                    </p>
                    <button
                      type="button"
                      onClick={() => setReviewVoucherModal(order.review_voucher)}
                      className="mt-3 rounded-xl bg-[#C9A84C] px-4 py-2 text-xs font-black text-[#0D0A06]"
                    >
                      Lihat Voucher Review
                    </button>
                  </div>
                )}

                {canOrderAgain && (
                  <button
                    type="button"
                    onClick={startNewOrder}
                    className="mt-5 w-full rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black uppercase tracking-[0.12em] text-[#0D0A06] shadow-lg shadow-black/25 transition hover:brightness-110"
                  >
                    Pesan Menu Lagi
                  </button>
                )}
              </motion.div>
            ) : renderCartPanel(false)}
          </AnimatePresence>
        </aside>
      </div>
      {!order && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[#C9A84C]/20 bg-[#0D0A06]/95 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setShowMobileCart(true)}
            className="flex w-full items-center justify-between rounded-2xl bg-[#C9A84C] px-4 py-3 font-black text-[#0D0A06] shadow-xl shadow-black/30"
          >
            <span>{itemCount ? `${itemCount} item` : 'Buka Keranjang'}</span>
            <span>{formatRp(total)}</span>
          </button>
        </div>
      )}
      <AnimatePresence>
        {!order && showMobileCart && (
          <>
            <motion.button
              type="button"
              aria-label="Tutup keranjang"
              className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowMobileCart(false)}
            />
            <motion.div
              className="fixed inset-x-0 bottom-0 z-[60] max-h-[88vh] overflow-y-auto lg:hidden"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            >
              {renderCartPanel(true)}
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {selectedProduct && !order && (
          <>
            <motion.button
              type="button"
              aria-label="Tutup detail menu"
              className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedProduct(null)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              className="fixed inset-x-3 top-1/2 z-[80] mx-auto max-w-md -translate-y-1/2 text-[#F5EDD8] [perspective:1200px]"
              initial={{ opacity: 0, y: 22, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 22, scale: 0.96 }}
            >
              <motion.div
                className="relative min-h-[520px] rounded-[2rem] [transform-style:preserve-3d]"
                animate={{ rotateY: productDetailFlipped ? 180 : 0 }}
                transition={{ type: 'spring', stiffness: 190, damping: 24 }}
              >
                <div
                  className="absolute inset-0 overflow-hidden rounded-[2rem] border border-[#C9A84C]/25 bg-[#1A1409] shadow-2xl shadow-black/60 [backface-visibility:hidden]"
                  onClick={() => setProductDetailFlipped(true)}
                >
                  <div className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-[#0D0A06]">
                    {selectedProduct.image_url ? (
                      <img
                        src={resolveAssetUrl(selectedProduct.image_url)}
                        alt={selectedProduct.name}
                        className="h-full w-full object-cover object-center"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-7xl">K</div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0D0A06] via-[#0D0A06]/82 to-transparent p-5">
                      <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#C9A84C]">{selectedProduct.category_name || 'Menu'}</p>
                      <div className="mt-2 flex items-end justify-between gap-3">
                        <h3 className="text-2xl font-black leading-tight">{selectedProduct.name}</h3>
                        <strong className="shrink-0 text-lg text-[#C9A84C]">{formatRp(selectedProduct.price)}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-4 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-3 py-1 text-xs font-black ${Number(selectedProduct.stock || 0) <= 0 || tableBusy ? 'bg-red-500/15 text-red-200' : 'bg-emerald-500/15 text-emerald-200'}`}>
                        {tableBusy ? 'Meja sedang aktif' : Number(selectedProduct.stock || 0) <= 0 ? 'Stok habis' : `${selectedProduct.stock} porsi siap`}
                      </span>
                      <span className="rounded-full border border-[#C9A84C]/20 px-3 py-1 text-xs font-bold text-[#EDE0C4]/70">
                        Klik kartu untuk lihat bahan
                      </span>
                    </div>
                    <p className="text-sm leading-6 text-[#EDE0C4]/70">
                      Foto menu memakai frame seragam dengan fokus tengah agar tampilan katalog tetap rapi.
                    </p>
                    <div className="grid grid-cols-[1fr_auto] gap-3">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setProductDetailFlipped(true);
                        }}
                        className="rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-sm font-black text-[#C9A84C]"
                      >
                        Lihat Bahan
                      </button>
                      <button
                        type="button"
                        onClick={async (event) => {
                          event.stopPropagation();
                          await addToCart(selectedProduct);
                          setSelectedProduct(null);
                        }}
                        disabled={tableBusy || Number(selectedProduct.stock || 0) <= 0}
                        className="rounded-2xl bg-[#C9A84C] px-5 py-3 text-sm font-black text-[#0D0A06] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Tambah
                      </button>
                    </div>
                  </div>
                </div>

                <div
                  className="absolute inset-0 overflow-hidden rounded-[2rem] border border-[#C9A84C]/25 bg-[#1A1409] p-5 shadow-2xl shadow-black/60 [backface-visibility:hidden] [transform:rotateY(180deg)]"
                  onClick={() => setProductDetailFlipped(false)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#C9A84C]">Bahan Menu</p>
                      <h3 className="mt-2 text-2xl font-black leading-tight">{selectedProduct.name}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedProduct(null);
                      }}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[#C9A84C]/20 text-[#C9A84C]"
                      aria-label="Tutup detail"
                    >
                      x
                    </button>
                  </div>
                  <div className="mt-5 max-h-[330px] space-y-2 overflow-y-auto pr-1">
                    {getProductIngredientNames(selectedProduct).length ? (
                      getProductIngredientNames(selectedProduct).map((ingredient, index) => (
                        <div key={`${ingredient}-${index}`} className="rounded-2xl border border-[#C9A84C]/14 bg-[#0D0A06]/55 px-4 py-3">
                          <p className="text-sm font-black">{ingredient}</p>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-[#C9A84C]/14 bg-[#0D0A06]/55 p-4 text-sm leading-6 text-[#EDE0C4]/70">
                        Detail bahan belum tersedia untuk menu ini.
                      </div>
                    )}
                  </div>
                  <div className="mt-5 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setProductDetailFlipped(false);
                      }}
                      className="rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-sm font-black text-[#C9A84C]"
                    >
                      Kembali
                    </button>
                    <button
                      type="button"
                      onClick={async (event) => {
                        event.stopPropagation();
                        await addToCart(selectedProduct);
                        setSelectedProduct(null);
                      }}
                      disabled={tableBusy || Number(selectedProduct.stock || 0) <= 0}
                      className="rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black text-[#0D0A06] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Tambah
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {leaveCartConfirmOpen && (
          <>
            <motion.button
              type="button"
              aria-label="Tutup konfirmasi pindah meja"
              className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setLeaveCartConfirmOpen(false)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              className="fixed inset-x-4 top-1/2 z-[100] mx-auto max-w-sm -translate-y-1/2 rounded-3xl border border-[#C9A84C]/25 bg-[#1A1409] p-5 text-[#F5EDD8] shadow-2xl shadow-black/50"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 18 }}
            >
              <p className="text-xs font-black uppercase tracking-[0.22em] text-[#C9A84C]">Pindah meja?</p>
              <h3 className="mt-2 text-xl font-black">Keranjang akan dikosongkan</h3>
              <p className="mt-2 text-sm leading-6 text-[#EDE0C4]/75">
                Menu yang sudah Anda pilih belum dikirim. Jika kembali ke pilihan meja, draft keranjang ini akan dihapus dan slot meja dilepas.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setLeaveCartConfirmOpen(false)}
                  className="rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-sm font-black text-[#C9A84C]"
                >
                  Tetap di sini
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLeaveCartConfirmOpen(false);
                    leaveToTableList({ clearCart: true });
                  }}
                  className="rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black text-[#0D0A06]"
                >
                  Hapus & Pindah
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {orderMessageModal && (
          <>
            <motion.button
              type="button"
              aria-label="Tutup pesan"
              className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOrderMessageModal(null)}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              className={`fixed inset-x-4 top-1/2 z-[100] mx-auto max-w-sm -translate-y-1/2 rounded-3xl border p-5 shadow-2xl shadow-black/50 ${
                orderMessageModal.tone === 'danger'
                  ? 'border-red-300/25 bg-[#251010] text-red-50'
                  : 'border-[#C9A84C]/25 bg-[#1A1409] text-[#F5EDD8]'
              }`}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 18 }}
            >
              <h3 className="text-xl font-black">{orderMessageModal.title}</h3>
              <p className="mt-2 text-sm leading-6 opacity-80">{orderMessageModal.message}</p>
              <button
                type="button"
                onClick={() => setOrderMessageModal(null)}
                className="mt-5 w-full rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black text-[#0D0A06]"
              >
                Mengerti
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {reviewModalOpen && order?.status === 'completed' && !order.reviewed_at && (
          <>
            <motion.button
              type="button"
              aria-label="Tutup review"
              className="fixed inset-0 z-[85] bg-black/75 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setReviewModalOpen(false)}
            />
            <motion.div
              className="fixed inset-x-3 bottom-4 z-[95] mx-auto max-h-[92vh] max-w-2xl overflow-y-auto rounded-3xl border border-[#C9A84C]/25 bg-[#1A1409] p-5 text-[#F5EDD8] shadow-2xl shadow-black/60 sm:inset-x-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.22em] text-[#C9A84C]">Review Pelanggan</p>
                  <h2 className="mt-2 text-2xl font-black">Bagaimana pengalaman makan Anda?</h2>
                  <p className="mt-2 text-sm leading-6 text-[#EDE0C4]/75">{reviewVoucherInfo}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setReviewModalOpen(false)}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[#C9A84C]/20 text-lg font-black text-[#C9A84C]"
                  aria-label="Tutup review"
                >
                  x
                </button>
              </div>

              <div className="mt-5 rounded-3xl border border-[#C9A84C]/15 bg-[#0D0A06]/55 p-4">
                <label className="block text-sm font-black text-[#C9A84C]">Rating pelayanan</label>
                <div className="mt-3 rounded-2xl border border-[#C9A84C]/15 bg-[#1A1409] p-3">
                  <StarPicker
                    value={review.service_rating}
                    onChange={(rating) => setReview((prev) => ({ ...prev, service_rating: rating }))}
                  />
                  <p className="mt-2 text-xs text-[#EDE0C4]/60">{review.service_rating} bintang</p>
                </div>
                <textarea
                  value={review.service_comment}
                  onChange={(e) => setReview((prev) => ({ ...prev, service_comment: e.target.value }))}
                  placeholder="Masukan untuk pelayanan..."
                  className="mt-3 w-full rounded-xl border border-[#C9A84C]/20 bg-[#1A1409] px-3 py-2 text-sm text-[#F5EDD8] outline-none"
                />
              </div>

              <div className="mt-4 space-y-3">
                {order.items?.map((item) => (
                  <div key={item.id} className="rounded-3xl border border-[#C9A84C]/12 bg-[#241C0E] p-4">
                    <p className="text-sm font-black">{item.product_name}</p>
                    <div className="mt-2 rounded-2xl border border-[#C9A84C]/15 bg-[#1A1409] p-3">
                      <StarPicker
                        value={review.items[item.id]?.rating || 5}
                        onChange={(rating) => setReview((prev) => ({
                          ...prev,
                          items: { ...prev.items, [item.id]: { ...prev.items[item.id], rating } },
                        }))}
                      />
                      <p className="mt-2 text-xs text-[#EDE0C4]/60">{review.items[item.id]?.rating || 5} bintang</p>
                    </div>
                    <input
                      value={review.items[item.id]?.comment || ''}
                      onChange={(e) => setReview((prev) => ({
                        ...prev,
                        items: { ...prev.items, [item.id]: { ...prev.items[item.id], comment: e.target.value } },
                      }))}
                      placeholder="Komentar menu ini..."
                      className="mt-2 w-full rounded-xl border border-[#C9A84C]/20 bg-[#1A1409] px-3 py-2 text-sm outline-none"
                    />
                  </div>
                ))}
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_1.2fr]">
                <button
                  type="button"
                  onClick={skipReview}
                  disabled={skipReviewLoading || reviewSubmitting}
                  className="rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-sm font-black text-[#C9A84C] disabled:opacity-50"
                >
                  {skipReviewLoading ? 'Memproses...' : 'Tidak Review'}
                </button>
                <button
                  type="button"
                  onClick={submitReview}
                  disabled={reviewSubmitting || skipReviewLoading}
                  className="rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black text-[#0D0A06] disabled:opacity-50"
                >
                  {reviewSubmitting ? 'Mengirim review...' : reviewRewardProgram ? 'Kirim Review dan Klaim Voucher' : 'Kirim Review'}
                </button>
              </div>
              <p className="mt-3 rounded-2xl bg-[#0D0A06]/55 p-3 text-xs leading-5 text-[#EDE0C4]/65">
                Setelah review dikirim atau dilewati, meja masuk cooldown 20 menit sebelum bisa dipakai untuk pesanan baru.
              </p>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {reviewVoucherModal && (
          <>
            <motion.button
              type="button"
              aria-label="Tutup voucher review"
              className="fixed inset-0 z-[105] bg-black/80 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setReviewVoucherModal(null)}
            />
            <ReviewVoucherCard
              voucher={reviewVoucherModal}
              order={order}
              onClose={() => setReviewVoucherModal(null)}
              storeLogoUrl={storeSettings?.logo_url}
              storeName={storeSettings?.store_name}
            />
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {paymentConfirmOrder && (
          <>
            <motion.div
              className="fixed inset-0 z-[90] bg-black/75 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.div
              className="fixed inset-x-3 bottom-4 z-[100] mx-auto max-w-md rounded-3xl border border-sky-300/25 bg-[#102026] p-5 text-sky-50 shadow-2xl shadow-black/60 sm:inset-x-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
            >
              <p className="text-xs font-black uppercase tracking-[0.22em] text-sky-200">Konfirmasi Pembayaran</p>
              <h2 className="mt-2 text-2xl font-black">Pesanan berhasil dibuat</h2>
              <p className="mt-2 text-sm leading-6 text-sky-50/75">
                Silakan lakukan pembayaran terlebih dahulu lewat {paymentConfirmOrder.payment_method?.name || 'metode pembayaran yang dipilih'}.
                Pesanan akan terlihat di kasir, tetapi baru bisa diterima setelah bukti pembayaran dikirim.
              </p>
              {paymentConfirmOrder.payment_method && (
                <div className="mt-4">
                  <PaymentMethodCard method={paymentConfirmOrder.payment_method} compact />
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-[#0D0A06]/55 p-3">
                  <p className="text-xs text-sky-100/60">Total bayar</p>
                  <strong className="mt-1 block text-xl text-emerald-300">{formatRp(paymentConfirmOrder.final_total || paymentConfirmOrder.subtotal)}</strong>
                </div>
                <div className="rounded-2xl bg-[#0D0A06]/55 p-3">
                  <p className="text-xs text-sky-100/60">Sisa waktu</p>
                  <strong className="mt-1 block text-xl text-sky-50">{formatPaymentTimeLeft(paymentConfirmOrder.payment_due_at)}</strong>
                  <p className="mt-1 text-[11px] text-sky-100/55">Sampai {formatDateTime(paymentConfirmOrder.payment_due_at)}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={scrollToPayment}
                className="mt-5 w-full rounded-2xl bg-sky-300 px-4 py-3 text-sm font-black uppercase tracking-[0.12em] text-[#0D0A06]"
              >
                Lanjut ke Pembayaran
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {bundlePrompt && (
          <>
            <motion.button
              type="button"
              aria-label="Tutup penawaran paket bundle"
              className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setBundlePrompt(null)}
            />
            <motion.div
              className="fixed inset-x-3 bottom-4 z-[80] mx-auto max-w-md rounded-3xl border border-[#C9A84C]/25 bg-[#1A1409] p-5 shadow-2xl shadow-black/60 sm:inset-x-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 24 }}
            >
              <p className="text-xs font-black uppercase tracking-[0.22em] text-[#C9A84C]">Paket Bundle</p>
              <h2 className="mt-2 text-xl font-black">{bundlePrompt.name}</h2>
              <p className="mt-2 text-sm leading-6 text-[#EDE0C4]/70">
                Pesanan Anda hampir memenuhi paket ini. Tambahkan menu berikut agar potongan {bundlePrompt.discountText} bisa terlihat di keranjang sebelum pesanan dikirim:
              </p>
              <div className="mt-4 space-y-2">
                {bundlePrompt.missingProducts.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-2xl bg-[#241C0E] px-3 py-2 text-sm">
                    <span className="line-clamp-1">{item.name}</span>
                    <strong className="text-[#C9A84C]">x{Math.max(1, Number(item.required_qty || 1) - Number(item.current_qty || 0))}</strong>
                  </div>
                ))}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const currentCart = cart;
                    setBundlePrompt(null);
                    submitOrderWithCart(currentCart);
                  }}
                  className="rounded-2xl border border-[#C9A84C]/25 px-4 py-3 text-sm font-black text-[#C9A84C]"
                >
                  Lewati
                </button>
                <button
                  type="button"
                  onClick={confirmBundleAndSubmit}
                  className="rounded-2xl bg-[#C9A84C] px-4 py-3 text-sm font-black text-[#0D0A06]"
                >
                  Tambah ke Keranjang
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </main>
  );
}
