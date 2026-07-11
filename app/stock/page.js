'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import AdminLayout from '@/components/layout/AdminLayout';
import { useAuthStore } from '@/store/authStore';
import SuccessModal from '@/components/stock/SuccessModal';
import StockIssuesTab from '@/components/stock/StockIssuesTab';
import { showConfirm } from '@/lib/modalDialog';
import {
  StockMasterSkeleton,
  StockRequestSkeleton,
  StockWarehouseSkeleton,
} from '@/components/ui/SectionSkeleton';
import DateRangePicker from '@/components/ui/DateRangePicker';
import {
  getStockItems, createStockItem, updateStockItem, deleteStockItem,
  getMainStockSummary, getMainStockMonthly, getMainStockDaily, getMainStockPriceTrends,
  addStockPurchase, getAllStockRequests, getMyStockRequests,
  submitStockRequest, deleteStockRequest, approveStockRequest,
  updateStockPurchase, deleteStockPurchase, addManualStockOut,
  getUsers, resubmitStockRequest, getProducts
} from '@/lib/api';
// Di AdminStockPage — tambah useEffect untuk baca query params dari POS
import { useSearchParams } from 'next/navigation';
const MASTER_TREND_CARD_PAGE_SIZE = 8;
const STOCK_IN_FILTER_PAGE_SIZE = 10;
const DEFAULT_TABLE_PAGE_SIZE = 10;
const TABLE_PAGE_SIZE_OPTIONS = [5, 10, 50, 100, 'all'];

const toLocalDateKey = (date = new Date()) => {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getCurrentMonthStartKey = () => {
  const now = new Date();
  return toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
};

const UNIT_GROUPS = [
  { label: 'Bahan Utama',  units: ['Kilogram','Gram','Kiloan','Butir','Buah','Ikat','Lembar','Pak','Kaleng'] },
  { label: 'Saus & Bumbu', units: ['Liter','Botol','Pouch','Sachet','Blok'] },
  { label: 'Packaging',    units: ['Pcs','Lusin'] },
];
const STOCK_REQUEST_FILTERS = [
  { val: '', label: 'Semua' },
  { val: 'pending', label: 'Menunggu' },
  { val: 'approved', label: 'Disetujui' },
  { val: 'rejected', label: 'Ditolak' },
];
// Format qty — tampilkan desimal hanya jika perlu
function fmtQty(val) {
  const n = Number(val || 0);
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2);
}

const normalizeSearch = (value) => String(value || '').toLowerCase().trim();
const rowMatchesSearch = (row, query, fields = []) => {
  const normalized = normalizeSearch(query);
  if (!normalized) return true;
  return fields.some((field) => normalizeSearch(row?.[field]).includes(normalized));
};

function getRequestedQtyFromIngredient(ingredient) {
  const qty = Number(
    ingredient?.request_qty ??
    ingredient?.qty_requested ??
    ingredient?.qty ??
    ingredient?.qty_per_portion ??
    1
  );

  return qty > 0 ? qty : 1;
}

function mergeStockRequestNotes(items) {
  return [...new Set(
    (Array.isArray(items) ? items : [])
      .map(item => String(item.note || '').trim())
      .filter(Boolean)
      .map(note => note.toLowerCase())
  )]
    .map(lowerNote => (
      (Array.isArray(items) ? items : [])
        .map(item => String(item.note || '').trim())
        .find(note => note.toLowerCase() === lowerNote)
    ))
    .filter(Boolean)
    .join('; ');
}

const getIngredientStockItemId = (ingredient) => Number(ingredient?.stock_item_id || ingredient?.id || 0);

function buildRecipeRows(product, menuQty = 1, stockRows = []) {
  if (!product?.ingredients?.length) return [];
  const qtyMultiplier = Math.max(1, Number(menuQty || 1));
  const byStockItem = new Map();

  product.ingredients.forEach((ingredient) => {
    const stockItemId = getIngredientStockItemId(ingredient);
    if (!stockItemId) return;
    const requiredQty = Number(ingredient.qty || ingredient.qty_per_portion || 1) * qtyMultiplier;
    const previous = byStockItem.get(stockItemId);
    byStockItem.set(stockItemId, {
      stock_item_id: stockItemId,
      ingredient_name: ingredient.ingredient_name || ingredient.name || `Bahan #${stockItemId}`,
      qty: Number(previous?.qty || 0) + requiredQty,
      unit: ingredient.unit || previous?.unit || '',
    });
  });

  return [...byStockItem.values()].map((row) => {
    const stock = stockRows.find((item) => Number(item.id) === Number(row.stock_item_id));
    const price = Number(stock?.price_per_unit || stock?.latest_cost_per_unit || 0);
    return {
      ...row,
      ingredient_name: stock?.name || row.ingredient_name,
      unit: stock?.unit || row.unit,
      current_stock: Number(stock?.current_stock || 0),
      price_per_unit: price,
      total_value: Number(row.qty || 0) * price,
    };
  });
}

const createEmptyRecipeSelection = () => ({ product_id: '', qty: 1 });

function getRecipeProducts(products = []) {
  return products.filter((product) => Array.isArray(product.ingredients) && product.ingredients.length > 0);
}

function getRecipeSelectionDetails(products = [], selections = []) {
  return (Array.isArray(selections) ? selections : [])
    .map((selection) => {
      const product = products.find((item) => String(item.id) === String(selection.product_id));
      if (!product) return null;
      const rawQty = selection.qty === '' || selection.qty === null || selection.qty === undefined
        ? 0
        : Number(selection.qty);
      return {
        product,
        qty: Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 0,
      };
    })
    .filter(Boolean)
    .filter((selection) => selection.qty > 0);
}

function hasRecipeProductSelection(selections = []) {
  return (Array.isArray(selections) ? selections : []).some((selection) => String(selection.product_id || '').trim());
}

function getRecipeSelectionLabel(products = [], selections = []) {
  return getRecipeSelectionDetails(products, selections)
    .map(({ product, qty }) => `${product.name} x${qty}`)
    .join(', ');
}

function getMaxMenuQtyFromStock(products = [], product, selections = [], stockRows = [], currentIndex = 0) {
  if (!product?.ingredients?.length) return 999;
  const otherRows = buildRecipeRowsForSelections(
    products,
    selections.filter((_, index) => index !== currentIndex),
    stockRows
  );
  const reservedByStockItem = new Map(otherRows.map((row) => [Number(row.stock_item_id), Number(row.qty || 0)]));

  const maxByIngredient = product.ingredients
    .map((ingredient) => {
      const stockItemId = getIngredientStockItemId(ingredient);
      const perPortion = Number(ingredient.qty || ingredient.qty_per_portion || 1);
      const stock = stockRows.find((item) => Number(item.id) === stockItemId);
      const available = Math.max(0, Number(stock?.current_stock || 0) - Number(reservedByStockItem.get(stockItemId) || 0));
      return perPortion > 0 ? Math.floor(available / perPortion) : 999;
    })
    .filter((value) => Number.isFinite(value));

  return Math.max(0, Math.min(...maxByIngredient, 999));
}

function buildRecipeRowsForSelections(products = [], selections = [], stockRows = []) {
  const byStockItem = new Map();

  getRecipeSelectionDetails(products, selections).forEach(({ product, qty }) => {
    buildRecipeRows(product, qty, stockRows).forEach((row) => {
      const previous = byStockItem.get(row.stock_item_id);
      const nextQty = Number(previous?.qty || 0) + Number(row.qty || 0);
      const sourceMenus = [
        ...(previous?.source_menus || []),
        `${product.name} x${qty}`,
      ];
      const price = Number(row.price_per_unit || previous?.price_per_unit || 0);

      byStockItem.set(row.stock_item_id, {
        ...row,
        qty: nextQty,
        source_menus: [...new Set(sourceMenus)],
        total_value: nextQty * price,
      });
    });
  });

  return [...byStockItem.values()];
}

function hasRowsOverStock(rows = []) {
  return (Array.isArray(rows) ? rows : []).some((row) => (
    Number(row.qty || 0) > Number(row.current_stock || 0)
  ));
}

function buildRecipeOutItemsForSelections(products = [], selections = []) {
  const label = getRecipeSelectionLabel(products, selections);

  return buildRecipeRowsForSelections(products, selections).map((row) => ({
    stock_item_id: String(row.stock_item_id),
    qty: String(row.qty),
    note: `Stok untuk ${label || 'produk'}`,
  }));
}

function RecipeMenuPicker({
  products = [],
  stockRows = [],
  selections = [createEmptyRecipeSelection()],
  onSelectionsChange,
  title = 'Buat stok menu',
}) {
  const recipeProducts = getRecipeProducts(products);
  const normalizedSelections = selections.length ? selections : [createEmptyRecipeSelection()];
  const selectedIds = normalizedSelections.map((selection) => String(selection.product_id)).filter(Boolean);

  useEffect(() => {
    const next = normalizedSelections.map((selection, index) => {
      const product = recipeProducts.find((item) => String(item.id) === String(selection.product_id));
      if (!product) return selection;
      const maxQty = Math.max(0, getMaxMenuQtyFromStock(recipeProducts, product, normalizedSelections, stockRows, index) || 0);
      const currentQty = Math.max(1, Number(selection.qty || 1));
      return currentQty > maxQty ? { ...selection, qty: maxQty } : selection;
    });
    if (JSON.stringify(next) !== JSON.stringify(normalizedSelections)) onSelectionsChange(next);
  }, [JSON.stringify(normalizedSelections), recipeProducts, stockRows, onSelectionsChange]);

  const updateSelection = (index, patch) => {
    const next = normalizedSelections.map((selection, selectionIndex) => (
      selectionIndex === index ? { ...selection, ...patch } : selection
    ));
    onSelectionsChange(next);
  };

  const addSelection = () => {
    onSelectionsChange([...normalizedSelections, createEmptyRecipeSelection()]);
  };

  const removeSelection = (index) => {
    const next = normalizedSelections.filter((_, selectionIndex) => selectionIndex !== index);
    onSelectionsChange(next.length ? next : [createEmptyRecipeSelection()]);
  };

  return (
    <div data-tour="stock-recipe-picker" className="rounded-xl border border-orange-500/20 bg-orange-500/10 p-4 space-y-3">
      <div>
        <p className="text-orange-300 text-sm font-black">{title}</p>
        <p className="text-slate-400 text-xs mt-0.5">
          Pilih satu atau beberapa menu dan jumlah porsi, bahan resep akan dihitung otomatis.
        </p>
      </div>
      <div className="space-y-3">
        {normalizedSelections.map((selection, index) => {
          const currentId = String(selection.product_id || '');
          const selectableProducts = recipeProducts.filter((product) => (
            currentId === String(product.id) || !selectedIds.includes(String(product.id))
          ));
          const selectedProduct = recipeProducts.find((product) => String(product.id) === currentId);
          const maxMenuQty = selectedProduct
            ? getMaxMenuQtyFromStock(recipeProducts, selectedProduct, normalizedSelections, stockRows, index)
            : 999;
          return (
            <div key={index} className="grid grid-cols-1 sm:grid-cols-[1fr_120px_auto] gap-3">
              <div data-tour="stock-recipe-menu-select">
                <label className="text-slate-500 text-xs mb-1 block">Menu pesanan {index + 1}</label>
                <select
                  value={selection.product_id}
                  onChange={(event) => updateSelection(index, { product_id: event.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50"
                >
                  <option value="">-- Manual / pilih menu --</option>
                  {selectableProducts.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} - {product.ingredients.length} bahan
                    </option>
                  ))}
                </select>
              </div>
              <div data-tour="stock-recipe-menu-qty">
                <label className="text-slate-500 text-xs mb-1 block">Qty menu</label>
                <input
                  type="number"
                  min="1"
                  max={Math.max(0, maxMenuQty || 0)}
                  value={selection.qty}
                  onChange={(event) => {
                    const rawQty = Math.max(1, Number(event.target.value || 1));
                    updateSelection(index, { qty: Math.min(rawQty, Math.max(0, maxMenuQty || 0)) });
                  }}
                  className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50"
                />
                {selectedProduct && (
                  <p className={`mt-1 text-[11px] ${Number(selection.qty || 1) > maxMenuQty ? 'text-red-300' : 'text-slate-500'}`}>
                    {maxMenuQty > 0 ? `Maks. bisa dibuat ${fmtQty(maxMenuQty)} porsi dari stok gudang` : 'Stok bahan belum cukup untuk menu ini'}
                  </p>
                )}
              </div>
              {normalizedSelections.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSelection(index)}
                  className="self-end rounded-xl border border-red-500/30 px-3 py-2.5 text-xs font-bold text-red-300 hover:bg-red-500/10"
                >
                  Hapus
                </button>
              )}
            </div>
          );
        })}
        <button
          data-tour="stock-recipe-add"
          type="button"
          onClick={addSelection}
          disabled={selectedIds.length >= recipeProducts.length}
          className="w-full rounded-xl border border-dashed border-orange-500/35 py-2.5 text-sm font-semibold text-orange-300 transition-all hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Tambah Menu
        </button>
      </div>
      {selectedIds.length > 0 && (
        <p data-tour="stock-recipe-note" className="text-[11px] leading-5 text-slate-400">
          Bahan baku dikunci dari resep produk. Ubah menu atau qty menu untuk menghitung ulang kebutuhan bahan.
        </p>
      )}
    </div>
  );

}

function ReadOnlyRecipeSummary({ rows = [], title = 'Ringkasan bahan resep' }) {
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-yellow-500/25 bg-yellow-500/10 p-4 text-xs text-yellow-200">
        Menu belum bisa dihitung. Pastikan qty menu lebih dari 0 dan stok bahan resep masih tersedia.
      </div>
    );
  }

  return (
    <div data-tour="stock-recipe-summary" className="rounded-xl border border-slate-600/40 bg-slate-700/40 p-4 space-y-3">
      <div>
        <p className="text-slate-200 text-sm font-black">{title}</p>
        <p className="text-slate-500 text-xs">Bahan tampil sebagai ringkasan, tidak bisa dipilih manual.</p>
      </div>
      {rows.map((row) => (
        <div key={row.stock_item_id} className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 rounded-lg bg-slate-800/50 px-3 py-2 text-xs">
          <div>
            <p className="text-white font-semibold">{row.ingredient_name}</p>
            <p className="text-slate-500">
              {fmtQty(row.qty)} {row.unit} · Stok gudang {fmtQty(row.current_stock)} {row.unit} · Rp {Number(row.price_per_unit || 0).toLocaleString('id-ID')}/{row.unit}
            </p>
          </div>
          <p className="text-orange-300 font-black sm:text-right">
            Rp {Number(row.total_value || 0).toLocaleString('id-ID')}
          </p>
        </div>
      ))}
      <div className="flex items-center justify-between border-t border-slate-600/50 pt-2">
        <span className="text-slate-400 text-xs">{rows.length} bahan</span>
        <strong className="text-white text-lg">
          Rp {rows.reduce((sum, row) => sum + Number(row.total_value || 0), 0).toLocaleString('id-ID')}
        </strong>
      </div>
    </div>
  );
}

function getPriceTrend(currentPrice, referencePrice) {
  const current = Number(currentPrice || 0);
  const reference = Number(referencePrice || 0);
  if (!current || !reference) return null;
  if (current > reference) return { label: 'Naik', cls: 'text-red-400', icon: '↑' };
  if (current < reference) return { label: 'Turun', cls: 'text-green-400', icon: '↓' };
  return { label: 'Stabil', cls: 'text-slate-400', icon: '•' };
}

function getPercentTrend(percent) {
  const value = Number(percent || 0);
  if (value > 0) return { label: `Naik ${value.toFixed(2)}%`, cls: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', icon: '↑' };
  if (value < 0) return { label: `Turun ${Math.abs(value).toFixed(2)}%`, cls: 'text-green-400', bg: 'bg-green-500/10 border-green-500/20', icon: '↓' };
  return { label: 'Stabil 0.00%', cls: 'text-slate-400', bg: 'bg-slate-700/40 border-slate-600/40', icon: '•' };
}
// ── Shared UI ─────────────────────────────────────────────────
function TabBtn({ active, onClick, children, ...props }) {
  return (
    <button onClick={onClick} {...props}
      className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
        active ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
               : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
      }`}>
      {children}
    </button>
  );
}

function SubTab({ active, onClick, children, ...props }) {
  return (
    <button onClick={onClick} {...props}
      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
        active ? 'bg-orange-500 text-white'
               : 'bg-slate-800 text-slate-400 border border-slate-700 hover:text-white hover:border-slate-600'
      }`}>
      {children}
    </button>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending:  { cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20', label: '⏳ Menunggu'  },
    approved: { cls: 'bg-green-500/15  text-green-400  border-green-500/20',  label: '✓ Disetujui' },
    rejected: { cls: 'bg-red-500/15    text-red-400    border-red-500/20',    label: '✕ Ditolak'   },
  };
  const s = map[status] || map.pending;
  return <span className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${s.cls}`}>{s.label}</span>;
}

const thC = 'text-left text-slate-500 text-xs font-semibold px-4 py-3 whitespace-nowrap';
const tdC = 'px-4 py-3 text-sm';
const trC = (i) => `border-b border-slate-700/30 hover:bg-slate-700/20 transition-colors ${i%2?'bg-slate-700/10':''}`;

function EmptyState({ icon = '📋', title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <span className="text-4xl mb-3">{icon}</span>
      <p className="text-slate-400 font-medium">{title}</p>
      {sub && <p className="text-slate-600 text-sm mt-1">{sub}</p>}
    </div>
  );
}

// ── ADMIN VIEW ────────────────────────────────────────────────
const normalizeTablePageSize = (value) => (value === 'all' ? 'all' : Number(value || DEFAULT_TABLE_PAGE_SIZE));
const getTablePageCount = (totalRows, pageSize) => {
  const normalized = normalizeTablePageSize(pageSize);
  if (normalized === 'all') return 1;
  return Math.max(1, Math.ceil(Number(totalRows || 0) / normalized));
};
const getTableOffset = (page, pageSize) => {
  const normalized = normalizeTablePageSize(pageSize);
  if (normalized === 'all') return 0;
  return Math.max(0, Number(page || 0) * normalized);
};
const getTableRows = (rows, page, pageSize) => {
  const data = Array.isArray(rows) ? rows : [];
  const normalized = normalizeTablePageSize(pageSize);
  if (normalized === 'all') return data;
  const start = getTableOffset(page, normalized);
  return data.slice(start, start + normalized);
};
const getTableRangeText = (totalRows, page, pageSize) => {
  const total = Number(totalRows || 0);
  if (!total) return '0 data';
  const normalized = normalizeTablePageSize(pageSize);
  if (normalized === 'all') return `1-${total}`;
  const start = getTableOffset(page, normalized) + 1;
  return `${start}-${Math.min(start + normalized - 1, total)}`;
};

function TablePagination({
  totalRows = 0,
  page = 0,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
  onPageChange,
  onPageSizeChange,
  label = 'data',
}) {
  const total = Number(totalRows || 0);
  const pageCount = getTablePageCount(total, pageSize);
  const normalizedSize = normalizeTablePageSize(pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/50 bg-slate-900/35 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-500">Tampil</span>
        <select
          value={normalizedSize}
          onChange={(event) => onPageSizeChange?.(normalizeTablePageSize(event.target.value))}
          className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-black text-slate-200 outline-none focus:border-orange-500/60"
        >
          {TABLE_PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option} value={option}>{option === 'all' ? 'All' : option}</option>
          ))}
        </select>
        <span className="text-xs text-slate-500">
          {getTableRangeText(total, page, normalizedSize)} dari {total} {label}
        </span>
      </div>

      {pageCount > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange?.(Math.max(0, page - 1))}
            disabled={page <= 0}
            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 transition-all hover:border-orange-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sebelumnya
          </button>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {Array.from({ length: pageCount }).map((_, pageIndex) => (
              <button
                key={pageIndex}
                type="button"
                onClick={() => onPageChange?.(pageIndex)}
                aria-label={`Lihat ${label} halaman ${pageIndex + 1}`}
                className={`h-2.5 rounded-full transition-all ${
                  page === pageIndex
                    ? 'w-8 bg-orange-400 shadow-lg shadow-orange-500/30'
                    : 'w-2.5 bg-slate-600 hover:bg-slate-400'
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => onPageChange?.(Math.min(pageCount - 1, page + 1))}
            disabled={page >= pageCount - 1}
            className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 transition-all hover:border-orange-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Berikutnya
          </button>
        </div>
      )}
    </div>
  );
}

function StockTutorialDemo() {
  const masterRows = [
    { name: 'Daging Cincang Bumbu', unit: 'gram', min: 5000, stock: 33800, price: 78, status: 'Aman' },
    { name: 'Saus Pedas Sultan', unit: 'ml', min: 2000, stock: 17875, price: 30, status: 'Aman' },
    { name: 'Cup Minuman', unit: 'pcs', min: 100, stock: 347, price: 1200, status: 'Aman' },
  ];
  const recipeRows = [
    { name: 'Daging Cincang Bumbu', qty: 160, unit: 'gram', stock: 33800, price: 78 },
    { name: 'Nasi Bulgur', qty: 180, unit: 'gram', stock: 39100, price: 22 },
    { name: 'Saus Pedas Sultan', qty: 25, unit: 'ml', stock: 17875, price: 30 },
  ];

  return (
    <div className="stock-tutorial-demo space-y-5">
      <div className="rounded-3xl border border-orange-400/35 bg-orange-500/5 p-4">
        <p className="text-xs font-black uppercase tracking-[0.22em] text-orange-300">Mode Demo Tutorial</p>
        <p className="mt-1 text-sm leading-6 text-slate-300">Data stok di area ini adalah dummy agar tutorial stabil. Form asli tetap terbuka saat step input berjalan.</p>
      </div>

      <section data-tour="stock-master" className="space-y-4 rounded-3xl border border-slate-700 bg-slate-800/70 p-4">
        <div data-tour="stock-master-actions" className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-300">24 bahan baku demo</p>
            <p className="mt-0.5 text-xs text-slate-500">Stok & harga dikelola di Stok Gudang - Catat Pembelian</p>
          </div>
          <div className="flex gap-2">
            <span className="rounded-xl bg-slate-700 px-3 py-2 text-xs font-bold text-slate-300">2026</span>
            <span className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white">+ Tambah Bahan</span>
          </div>
        </div>
        <div data-tour="stock-master-trends" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {masterRows.map((row) => (
            <div key={row.name} className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
              <p className="text-sm font-bold text-white">{row.name}</p>
              <p className="mt-2 text-xs text-slate-500">Avg Rp {row.price.toLocaleString('id-ID')} / {row.unit}</p>
              <p className="mt-1 text-xs font-bold text-emerald-400">Stabil 0.00%</p>
            </div>
          ))}
        </div>
        <div data-tour="stock-master-table" className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/70">
                  {['Nama Bahan', 'Satuan', 'Min. Stok', 'Stok Saat Ini', 'Harga/Satuan', 'Status', 'Aksi'].map((head) => (
                    <th key={head} className={thC}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {masterRows.map((row, index) => (
                  <tr key={row.name} className={trC(index)}>
                    <td className={`${tdC} font-semibold text-white`}>{row.name}</td>
                    <td className={`${tdC} text-slate-400`}>{row.unit}</td>
                    <td className={`${tdC} text-slate-400`}>{row.min} {row.unit}</td>
                    <td className={`${tdC} font-bold text-white`}>{row.stock} {row.unit}</td>
                    <td className={`${tdC} text-slate-300`}>Avg Rp {row.price.toLocaleString('id-ID')}</td>
                    <td className={tdC}><span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-bold text-green-400">{row.status}</span></td>
                    <td className={tdC}><div className="flex gap-2"><span className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-300">Edit</span><span className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-300">Hapus</span></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section data-tour="stock-warehouse" className="space-y-4 rounded-3xl border border-slate-700 bg-slate-800/70 p-4">
        <div data-tour="stock-warehouse-tabs" className="flex flex-wrap gap-2">
          <span className="rounded-xl bg-orange-500 px-3 py-1.5 text-xs font-bold text-white">Saldo Stok</span>
          <span className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-bold text-slate-300">Pemasukan</span>
          <span className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-bold text-slate-300">Pengeluaran</span>
        </div>
        <div data-tour="stock-summary" className="space-y-4">
          <div data-tour="stock-summary-cards" className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4"><p className="text-xs text-slate-400">Total Nilai Masuk</p><p className="mt-2 text-xl font-black text-emerald-300">Rp 68.250.000</p></div>
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4"><p className="text-xs text-slate-400">Total Nilai Keluar</p><p className="mt-2 text-xl font-black text-red-300">Rp 16.467.615</p></div>
            <div className="rounded-2xl border border-sky-500/20 bg-sky-500/10 p-4"><p className="text-xs text-slate-400">Nilai Stok Gudang</p><p className="mt-2 text-xl font-black text-sky-300">Rp 51.782.385</p></div>
          </div>
          <div data-tour="stock-summary-table" className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
            <p className="text-sm font-black text-white">Saldo bahan demo</p>
            <div className="mt-3 grid gap-2">
              {masterRows.map((row) => (
                <div key={row.name} className="grid gap-2 rounded-xl bg-slate-800 px-3 py-2 text-xs sm:grid-cols-[1fr_auto_auto]">
                  <span className="font-semibold text-white">{row.name}</span>
                  <span className="text-slate-400">Saldo {row.stock} {row.unit}</span>
                  <span className="font-bold text-green-400">{row.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div data-tour="stock-in" className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
          <div data-tour="stock-in-filters" className="flex flex-wrap items-center gap-2">
            <span className="rounded-xl bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300">Jun 2026</span>
            <span className="rounded-xl bg-orange-500/15 px-3 py-2 text-xs font-bold text-orange-300">Semua bahan</span>
          </div>
          <div data-tour="stock-in-table" className="mt-3 rounded-xl border border-slate-800 p-3 text-sm text-slate-300">
            Pembelian demo: Daging Cincang Bumbu 1.000 gram x Rp 78 = Rp 78.000
          </div>
        </div>
        <div data-tour="stock-out" className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
          <div data-tour="stock-out-filters" className="flex flex-wrap gap-2">
            <span className="rounded-xl bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300">1 Jun 2026 - 8 Jun 2026</span>
            <span className="rounded-xl bg-orange-500 px-3 py-2 text-xs font-bold text-white">Cari</span>
          </div>
          <div data-tour="stock-out-pills" className="mt-3 flex flex-wrap gap-2">
            {['Semua', 'Sudah Keluar', 'Menunggu', 'Ditolak', 'Transaksi POS'].map((label, index) => (
              <span key={label} className={`rounded-full px-3 py-1 text-xs font-bold ${index === 0 ? 'bg-orange-500 text-white' : 'bg-slate-800 text-slate-400'}`}>{label}</span>
            ))}
          </div>
          <div data-tour="stock-out-table" className="mt-3 rounded-xl border border-slate-800 p-3 text-sm text-slate-300">
            Pengeluaran demo: Adana Kebab Platter x1 memakai {recipeRows.length} bahan resep.
          </div>
        </div>
      </section>

      <section data-tour="stock-requests" className="space-y-3 rounded-3xl border border-slate-700 bg-slate-800/70 p-4">
        <div data-tour="stock-request-filters" className="flex flex-wrap items-center gap-2">
          <span className="rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-slate-300">1 Jun 2026 - 8 Jun 2026</span>
          {['Semua', 'Menunggu', 'Disetujui', 'Ditolak'].map((label, index) => (
            <span key={label} className={`rounded-xl px-3 py-2 text-xs font-bold ${index === 1 ? 'bg-yellow-500/15 text-yellow-300' : 'bg-slate-900 text-slate-400'}`}>{label}</span>
          ))}
        </div>
        <div data-tour="stock-request-list" className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black text-white">Kasir Tutorial</p>
              <p className="mt-1 text-xs text-slate-500">Stok untuk Adana Kebab Platter</p>
            </div>
            <span className="rounded-full bg-yellow-500/15 px-3 py-1 text-xs font-black text-yellow-300">Menunggu</span>
          </div>
          <div className="mt-3 grid gap-2">
            {recipeRows.map((row) => (
              <div key={row.name} className="grid gap-2 rounded-xl bg-slate-800 px-3 py-2 text-xs sm:grid-cols-[1fr_auto_auto]">
                <span className="font-semibold text-white">{row.name}</span>
                <span className="text-slate-400">{row.qty} {row.unit}</span>
                <span className="font-bold text-orange-300">Rp {(row.qty * row.price).toLocaleString('id-ID')}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function AdminStockPage({ successModal, setSuccessModal }) {
  const { selectedBranchId, user } = useAuthStore();
  const [tab,     setTab]     = useState('master');
  const [mainTab, setMainTab] = useState('summary');

  // Master
  const [stockItems,  setStockItems]  = useState([]);
  const [showForm,    setShowForm]    = useState(false);
  const [editId,      setEditId]      = useState(null);
  const [formData,    setFormData]    = useState({ name:'', unit:'Pcs', min_stock:'' });
  const [formLoading, setFormLoading] = useState(false);
  const [masterLoading, setMasterLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendCardsExpanded, setTrendCardsExpanded] = useState(false);
  const [trendCardPage, setTrendCardPage] = useState(0);
  const [masterTablePage, setMasterTablePage] = useState(0);
  const [masterTablePageSize, setMasterTablePageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [summaryTablePage, setSummaryTablePage] = useState(0);
  const [summaryTablePageSize, setSummaryTablePageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [stockInTablePage, setStockInTablePage] = useState(0);
  const [stockInTablePageSize, setStockInTablePageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [stockOutTablePage, setStockOutTablePage] = useState(0);
  const [stockOutTablePageSize, setStockOutTablePageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [masterSearch, setMasterSearch] = useState('');
  const [warehouseSearch, setWarehouseSearch] = useState('');
  const [requestSearch, setRequestSearch] = useState('');
  const [stockInFilterExpanded, setStockInFilterExpanded] = useState(false);
  const [stockInFilterPage, setStockInFilterPage] = useState(0);

  // Gudang
  const [summary,  setSummary]  = useState([]);
  const [globalSummary, setGlobalSummary] = useState([]);
  const [priceTrends, setPriceTrends] = useState([]);
  const [trendYear, setTrendYear] = useState(new Date().getFullYear());
  const [monthly,  setMonthly]  = useState([]);
  const [daily,    setDaily]    = useState([]);
  const [selMonth, setSelMonth] = useState(new Date().getMonth() + 1);
  const [selYear,  setSelYear]  = useState(new Date().getFullYear());
  const [stockInDateFrom, setStockInDateFrom] = useState(getCurrentMonthStartKey);
  const [stockInDateTo, setStockInDateTo] = useState(() => toLocalDateKey());
  const [selDate,  setSelDate]  = useState(() => toLocalDateKey());

  // ✅ FIX: pindahkan selDateTo ke SINI, sebelum loadDaily
  const [selDateTo, setSelDateTo] = useState(() => toLocalDateKey());

  // Pembelian
  const [showPurchase, setShowPurchase] = useState(false);
  const [purchItems,   setPurchItems]   = useState([{ stock_item_id:'', qty:'', cost_per_unit:'' }]);
  const [purchNote,    setPurchNote]    = useState('');
  const [purchLoading, setPurchLoading] = useState(false);

  // Pengajuan
  const [requests,     setRequests]     = useState([]);
  const [reqDate,      setReqDate]      = useState(new Date().toISOString().split('T')[0]);
  const [reqStatus,    setReqStatus]    = useState('pending');
  const [approveModal, setApproveModal] = useState(null);
  const [approveItems, setApproveItems] = useState([]);

  // Tambah setelah state existing di AdminStockPage
  const [editPurchase,  setEditPurchase]  = useState(null); // { id, item }
  const [reqDateFrom,   setReqDateFrom]   = useState('');
  const [reqDateTo,     setReqDateTo]     = useState('');
  // Filter: hanya bahan yang punya stok dari main_stock (bukan stock_items.stock)
  // Gunakan summary yang sudah di-load
  const availableForOut = summary.filter(s => Number(s.current_stock) > 0);
  const [users,      setUsers]      = useState([]);
  const [outUserId,  setOutUserId]  = useState('');
  const [productOptions, setProductOptions] = useState([]);
  const [outMenuSelections, setOutMenuSelections] = useState([createEmptyRecipeSelection()]);

  // Tambah state di AdminStockPage (setelah state daily)
  const [outTypeFilter, setOutTypeFilter] = useState('all');

  const hasOutMenuSelection = hasRecipeProductSelection(outMenuSelections);
  const hasOutRecipeSelection = getRecipeSelectionDetails(productOptions, outMenuSelections).length > 0;
  const outRecipeRows = hasOutRecipeSelection ? buildRecipeRowsForSelections(productOptions, outMenuSelections, summary) : [];
  const outRecipeOverStock = hasRowsOverStock(outRecipeRows);
  const outRecipeSelectionLabel = getRecipeSelectionLabel(productOptions, outMenuSelections);
  const syncOutRecipeSelections = (nextSelections) => {
    setOutMenuSelections(nextSelections);
    if (!hasRecipeProductSelection(nextSelections)) {
      setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
      return;
    }
    setOutItems(buildRecipeOutItemsForSelections(productOptions, nextSelections));
  };

  // // Update loadDaily — tambah type_filter
  // const loadDaily = useCallback(() =>
  //   getMainStockDaily({
  //     date_from:   selDate,
  //     date_to:     selDateTo || selDate,
  //     type_filter: outTypeFilter !== 'all' ? outTypeFilter : undefined,
  //   }).then(r => setDaily(Array.isArray(r.data) ? r.data : [])),
  //   [selDate, selDateTo, outTypeFilter]);

  // ✅ FIX: sekarang selDateTo sudah dideklarasikan sebelumnya — tidak ada error
  const loadDaily = useCallback(() => {
    setDailyLoading(true);
    return getMainStockDaily({
      date_from:   selDate,
      date_to:     selDateTo || selDate,
      type_filter: outTypeFilter !== 'all' ? outTypeFilter : undefined,
    })
      .then(r => setDaily(Array.isArray(r.data) ? r.data : []))
      .finally(() => setDailyLoading(false));
  }, [selDate, selDateTo, outTypeFilter, selectedBranchId]);

  // Definisi filter — sama untuk admin & kasir
  const OUT_FILTERS = [
    { val: 'all',         label: 'Semua'          },
    { val: 'approved',    label: '✓ Sudah Keluar' },
    { val: 'pending',     label: '⏳ Menunggu'     },
    { val: 'rejected',    label: '✕ Ditolak'       },
    { val: 'transaction', label: '🧾 Transaksi POS'},
    { val: 'manual',      label: '📋 Manual Kasir' },
  ];

  // Warna badge per status
  function TypeBadge({ type, status }) {
    if (type === 'transaction') return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/20">
        🧾 Transaksi
      </span>
    );
    if (type === 'pending_out' && status === 'pending') return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
        📋 Menunggu
      </span>
    );
    if (type === 'pending_out' && status === 'rejected') return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
        📋 Ditolak
      </span>
    );
    return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-green-500/15 text-green-400 border border-green-500/20">
        📦 Keluar
      </span>
    );
  }

  // 📊 CONSOLIDATED BALANCE SOURCE: Use main_stock summary as single source of truth
  // ✓ Reason: main_stock table contains immutable audit trail of all stock movements
  // ✓ Calculation: balance = SUM(IN movements) - SUM(OUT movements) from main_stock
  // ✓ Fallback: If summary unavailable, show "Loading..." instead of stale stock_items.stock
  const stockItemsWithSummary = stockItems.map(item => {
    const sum = summary.find(s => s.id === item.id);
    const global = globalSummary.find(s => s.id === item.id);
    
    // If summary exists (API returned calculated balance from main_stock), use it
    // Otherwise, mark as pending/loading (do NOT fallback to item.stock which may be out of sync)
    const currentStock = sum 
      ? Number(sum.current_stock)
      : null; // null indicates we're waiting for the calculated value

    const costPerUnit = global && Number(global.total_in) > 0
      ? Math.round(Number(global.total_cost_in) / Number(global.total_in))
      : Number(item.price_per_unit || 0);

    return {
      ...item,
      display_stock: currentStock,
      display_price_per: costPerUnit,
      display_latest_price: Number(global?.latest_cost_per_unit || 0),
      stock_from_main: !!sum, // Track if this came from main_stock (reliable) or is pending
    };
  });
  const filteredStockItemsWithSummary = useMemo(() => stockItemsWithSummary.filter((item) => rowMatchesSearch(item, masterSearch, [
    'name', 'unit', 'status',
  ])), [stockItemsWithSummary, masterSearch]);
  const filteredPriceTrends = useMemo(() => priceTrends.filter((trend) => rowMatchesSearch(trend, masterSearch, [
    'name', 'unit',
  ])), [priceTrends, masterSearch]);
  const trendCardPageCount = Math.max(1, Math.ceil(filteredPriceTrends.length / MASTER_TREND_CARD_PAGE_SIZE));
  const visibleTrendCards = trendCardsExpanded
    ? filteredPriceTrends
    : filteredPriceTrends.slice(
        trendCardPage * MASTER_TREND_CARD_PAGE_SIZE,
        trendCardPage * MASTER_TREND_CARD_PAGE_SIZE + MASTER_TREND_CARD_PAGE_SIZE
      );
  const masterTablePageCount = getTablePageCount(filteredStockItemsWithSummary.length, masterTablePageSize);
  const visibleMasterItems = getTableRows(filteredStockItemsWithSummary, masterTablePage, masterTablePageSize);

  const searchParams = useSearchParams();

  useEffect(() => {
    if (trendCardPage >= trendCardPageCount) setTrendCardPage(0);
  }, [trendCardPage, trendCardPageCount]);

  useEffect(() => {
    if (masterTablePage >= masterTablePageCount) setMasterTablePage(0);
  }, [masterTablePage, masterTablePageCount]);

  useEffect(() => {
    setMasterTablePage(0);
    setTrendCardPage(0);
  }, [masterSearch]);

  useEffect(() => {
    const fromPos     = searchParams.get('from') === 'pos';
    const ingredients = searchParams.get('ingredients');
    const userId      = searchParams.get('user_id');
    const productName = searchParams.get('product_name');

    if (fromPos && ingredients) {
      try {
        const parsedIngs = JSON.parse(ingredients);
        // Auto-fill form pengeluaran
        setTab('main');
        setMainTab('out');
        setShowOutForm(true);
        setOutMenuSelections([createEmptyRecipeSelection()]);
        setOutItems(parsedIngs.map(ing => ({
          stock_item_id: String(ing.stock_item_id),
          qty: String(getRequestedQtyFromIngredient(ing)),
          note: `Stok untuk ${productName || 'produk'}`,
        })));
        if (userId) setOutUserId(userId);
      } catch (_) {}
    }
  }, [searchParams]);

  // Load users saat component mount
  useEffect(() => {
    getUsers().then(r => setUsers(r.data)).catch(() => {});
    getProducts().then(r => setProductOptions(Array.isArray(r.data) ? r.data : [])).catch(() => setProductOptions([]));
  }, []);
  // Ganti reqDate dengan range
  const [reqDateFrom2,  setReqDateFrom2]  = useState(() => toLocalDateKey());
  const [reqDateTo2,    setReqDateTo2]    = useState(() => toLocalDateKey());

  // Form pengeluaran manual
  const [showOutForm,   setShowOutForm]   = useState(false);
  const [outItems,      setOutItems]      = useState([{ stock_item_id:'', qty:'', note:'' }]);
  const [outLoading,    setOutLoading]    = useState(false);

  // const [selDateTo, setSelDateTo] = useState(new Date().toISOString().split('T')[0]);

  const loadRequests = useCallback(() => {
    setRequestsLoading(true);
    return getAllStockRequests({
      date_from: reqDateFrom2 || undefined,
      date_to:   reqDateTo2   || undefined,
      status:    reqStatus    || undefined,
    })
      .then(r => setRequests(r.data))
      .finally(() => setRequestsLoading(false));
  }, [reqDateFrom2, reqDateTo2, reqStatus]);
  // const loadDaily = useCallback(() =>
  // getMainStockDaily({ date_from: selDate, date_to: selDateTo || selDate })
  //   .then(r => setDaily(r.data)), [selDate, selDateTo]);

  const loadMaster = useCallback(() => {
    setMasterLoading(true);
    return getStockItems()
      .then(r => setStockItems(r.data))
      .finally(() => setMasterLoading(false));
  }, []);
  // const loadSummary  = useCallback(() => getMainStockSummary().then(r => setSummary(r.data)), []);
  // Di KasirStockPage — loadSummary sudah ada catch, pastikan seperti ini:
  const loadSummary = useCallback(() => {
    setSummaryLoading(true);
    return getMainStockSummary()
      .then(r => setSummary(Array.isArray(r.data) ? r.data : []))
      .catch(err => {
        console.error('Summary error:', err.response?.status, err.response?.data);
        setSummary([]);
      })
      .finally(() => setSummaryLoading(false));
  }, [selectedBranchId]);
  const loadGlobalSummary = useCallback(() =>
    getMainStockSummary({ branch_id: 'all' })
      .then(r => setGlobalSummary(Array.isArray(r.data) ? r.data : []))
      .catch(() => setGlobalSummary([])), []);
  const loadPriceTrends = useCallback(() => {
    setTrendLoading(true);
    return getMainStockPriceTrends({ year: trendYear })
      .then(r => setPriceTrends(Array.isArray(r.data) ? r.data : []))
      .catch(() => setPriceTrends([]))
      .finally(() => setTrendLoading(false));
  }, [trendYear]);
  const loadMonthly = useCallback(() => {
    setMonthlyLoading(true);
    return getMainStockMonthly({
      month: selMonth,
      year: selYear,
      date_from: stockInDateFrom || undefined,
      date_to: stockInDateTo || undefined,
    })
      .then(r => setMonthly(r.data))
      .finally(() => setMonthlyLoading(false));
  }, [selMonth, selYear, stockInDateFrom, stockInDateTo, selectedBranchId]);
  // const loadDaily    = useCallback(() =>
  //   getMainStockDaily({ date: selDate }).then(r => setDaily(r.data)), [selDate]);
  // const loadRequests = useCallback(() =>
  //   getAllStockRequests({ date: reqDate || undefined, status: reqStatus || undefined })
  //     .then(r => setRequests(r.data)), [reqDate, reqStatus]);

  useEffect(() => { loadMaster(); loadSummary(); loadGlobalSummary(); loadPriceTrends(); }, [loadMaster, loadSummary, loadGlobalSummary, loadPriceTrends]);
  // useEffect(() => { if (tab==='main') { loadMonthly(); loadDaily(); } }, [tab, selMonth, selYear, selDate]);
  const [filterItemId, setFilterItemId] = useState(null); // null = semua
  // Ganti useEffect ini
  // useEffect(() => {
  //   if (tab === 'main') {
  //     loadMonthly();
  //     loadDaily();
  //     setFilterItemId(null); // reset filter bahan saat ganti bulan/tahun
  //   }
  // }, [tab, selMonth, selYear, selDate]);

  // Di AdminStockPage — useEffect yang sudah ada, tambah chain:
  useEffect(() => {
    if (tab === 'main') {
      loadMonthly();
      // FIX: load summary dulu, baru daily
      loadSummary().then(() => loadDaily());
      setFilterItemId(null);
    }
  }, [tab, selMonth, selYear, selDate, selectedBranchId, loadMonthly, loadSummary, loadDaily]);

  // FIX: tambah useEffect untuk outTypeFilter di admin
  useEffect(() => {
    if (tab === 'main' && mainTab === 'out') {
      loadDaily();
    }
  }, [outTypeFilter, mainTab, selectedBranchId, loadDaily]);
  useEffect(() => { if (tab==='requests') loadRequests(); }, [tab, loadRequests]);

  const resetForm = () => { setShowForm(false); setEditId(null); setFormData({ name:'', unit:'Pcs', min_stock:'' }); };

  const handleSaveMaster = async () => {
    if (!formData.name.trim()) return alert('Nama bahan wajib diisi');
    setFormLoading(true);
    try {
      const payload = { name: formData.name.trim(), unit: formData.unit, min_stock: Number(formData.min_stock)||0, stock:0, total_price:0 };
      if (editId) await updateStockItem(editId, payload);
      else        await createStockItem(payload);
      resetForm(); loadMaster();
    } catch(e) { alert(e.response?.data?.message || 'Gagal'); }
    finally { setFormLoading(false); }
  };

  const handlePurchase = async () => {
    const valid = purchItems.every(i => i.stock_item_id && Number(i.qty)>0 && Number(i.cost_per_unit)>0);
    if (!valid) return alert('Lengkapi semua item (bahan, jumlah, harga/satuan)');
    setPurchLoading(true);
    try {
      await addStockPurchase({
        items: purchItems.map(i => ({
          stock_item_id: Number(i.stock_item_id),
          qty:           Number(i.qty),
          cost_per_unit: Number(i.cost_per_unit),
        })),
        note: purchNote,
      });
      setShowPurchase(false);
      setPurchItems([{ stock_item_id:'', qty:'', cost_per_unit:'' }]);
      setPurchNote('');
      loadSummary(); loadMaster(); loadMonthly();
    } catch(e) { alert(e.response?.data?.message || 'Gagal'); }
    finally { setPurchLoading(false); }
  };

  const handleApprove = async (action) => {
    try {
      await approveStockRequest(approveModal.id, {
        action,
        approved_items: approveItems.map(i => ({
          request_item_id: i.id,
          qty_approved: Number(i.qty_approved ?? i.qty_requested),
        })),
      });
      setApproveModal(null);
      loadRequests(); loadSummary(); loadMaster();
    } catch(e) { alert(e.response?.data?.message || 'Gagal'); }
  };

  const totalIn  = summary.reduce((s,r) => s + Number(r.total_cost_in),  0);
  const totalOut = summary.reduce((s,r) => s + Number(r.total_cost_out), 0);
  const inData   = monthly.filter(r => r.type==='in');
  // const outData  = daily.length > 0 ? daily : monthly.filter(r => r.type==='out');
  const outData = daily;
  const filteredSummary = summary.filter((row) => rowMatchesSearch(row, warehouseSearch, ['name', 'unit']));
  const summaryTablePageCount = getTablePageCount(filteredSummary.length, summaryTablePageSize);
  const visibleSummaryRows = getTableRows(filteredSummary, summaryTablePage, summaryTablePageSize);
  const searchedInData = inData.filter((row) => rowMatchesSearch(row, warehouseSearch, [
    'item_name', 'unit', 'note', 'created_by_name',
  ]));
  const stockInFilterNames = [...new Map(searchedInData.map(r => [r.item_name, r.item_name])).values()];
  const stockInFilterPageCount = Math.max(1, Math.ceil(stockInFilterNames.length / STOCK_IN_FILTER_PAGE_SIZE));
  const visibleStockInFilterNames = stockInFilterExpanded
    ? stockInFilterNames
    : stockInFilterNames.slice(
        stockInFilterPage * STOCK_IN_FILTER_PAGE_SIZE,
        stockInFilterPage * STOCK_IN_FILTER_PAGE_SIZE + STOCK_IN_FILTER_PAGE_SIZE
      );
  const filteredInRows = filterItemId
    ? searchedInData.filter((row) => row.item_name === filterItemId)
    : searchedInData;
  const stockInTablePageCount = getTablePageCount(filteredInRows.length, stockInTablePageSize);
  const visibleStockInRows = getTableRows(filteredInRows, stockInTablePage, stockInTablePageSize);
  const searchedOutData = outData.filter((row) => rowMatchesSearch(row, warehouseSearch, [
    'item_name', 'unit', 'note', 'branch_name', 'stock_owner_name', 'target_user_name', 'created_by_name', 'admin_name', 'request_status', 'type',
  ]));
  const stockOutTablePageCount = getTablePageCount(searchedOutData.length, stockOutTablePageSize);
  const visibleStockOutRows = getTableRows(searchedOutData, stockOutTablePage, stockOutTablePageSize);
  const filteredRequests = requests.filter((req) => {
    const requestFieldsMatch = rowMatchesSearch(req, requestSearch, [
      'user_name', 'status', 'note', 'approved_by_name', 'created_by_admin_name',
    ]);
    const itemMatch = (req.items || []).some((item) => rowMatchesSearch(item, requestSearch, [
      'item_name', 'unit', 'note',
    ]));
    return requestFieldsMatch || itemMatch;
  });
  const selectedBranchName = user?.branch_name || (selectedBranchId ? `Cabang #${selectedBranchId}` : 'Cabang aktif');
  const masterInitialLoading = (masterLoading && stockItems.length === 0)
    || (summaryLoading && summary.length === 0)
    || (trendLoading && priceTrends.length === 0);
  const warehouseInitialLoading = (mainTab === 'summary' && summaryLoading && summary.length === 0)
    || (mainTab === 'in' && monthlyLoading && monthly.length === 0)
    || (mainTab === 'out' && dailyLoading && daily.length === 0);
  const requestsInitialLoading = requestsLoading && requests.length === 0;
  const stockRefreshing = Boolean(
    (masterLoading && stockItems.length > 0)
    || (summaryLoading && summary.length > 0)
    || (trendLoading && priceTrends.length > 0)
    || (monthlyLoading && monthly.length > 0)
    || (dailyLoading && daily.length > 0)
    || (requestsLoading && requests.length > 0)
  );

  useEffect(() => {
    if (stockInFilterPage >= stockInFilterPageCount) setStockInFilterPage(0);
  }, [stockInFilterPage, stockInFilterPageCount]);

  useEffect(() => {
    if (summaryTablePage >= summaryTablePageCount) setSummaryTablePage(0);
  }, [summaryTablePage, summaryTablePageCount]);

  useEffect(() => {
    if (stockInTablePage >= stockInTablePageCount) setStockInTablePage(0);
  }, [stockInTablePage, stockInTablePageCount]);

  useEffect(() => {
    if (stockOutTablePage >= stockOutTablePageCount) setStockOutTablePage(0);
  }, [stockOutTablePage, stockOutTablePageCount]);

  useEffect(() => {
    setSummaryTablePage(0);
    setStockInTablePage(0);
    setStockOutTablePage(0);
  }, [warehouseSearch, mainTab, filterItemId, stockInDateFrom, stockInDateTo, selDate, selDateTo, outTypeFilter]);

  useEffect(() => {
    setStockInFilterExpanded(false);
    setStockInFilterPage(0);
    setFilterItemId(null);
  }, [warehouseSearch, stockInDateFrom, stockInDateTo]);

  return (
    <>
      <div data-tour="stock-tabs" className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2 bg-slate-800/50 rounded-2xl p-1.5 w-fit">
        <TabBtn data-tour-action="stock-tab-master" active={tab==='master'}   onClick={() => setTab('master')}>   📦 Bahan Baku</TabBtn>
        <TabBtn data-tour-action="stock-tab-warehouse" active={tab==='main'}     onClick={() => setTab('main')}>     🏪 Stok Gudang</TabBtn>
        <TabBtn data-tour-action="stock-tab-requests" active={tab==='requests'} onClick={() => setTab('requests')}> 📋 Pengajuan Kasir</TabBtn>
        <TabBtn data-tour-action="stock-tab-issues" active={tab==='issues'} onClick={() => setTab('issues')}> ⚠️ Sisa Stok</TabBtn>
        </div>
        {stockRefreshing && (
          <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-200">
            Sinkronisasi stok...
          </span>
        )}
      </div>

      {/* ── BAHAN BAKU ── */}
      {tab==='master' && (
        masterInitialLoading ? (
          <StockMasterSkeleton />
        ) : (
        <div data-tour="stock-master" className="space-y-4">
          <div data-tour="stock-master-actions" className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-slate-300 text-sm font-semibold">{filteredStockItemsWithSummary.length} bahan baku</p>
              <p className="text-slate-600 text-xs mt-0.5">Stok & harga dikelola di Stok Gudang → Catat Pembelian</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={masterSearch}
                onChange={(e) => setMasterSearch(e.target.value)}
                placeholder="Cari bahan baku..."
                className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-white outline-none placeholder:text-slate-500 focus:border-orange-500/60 sm:w-56"
              />
              <select
                value={trendYear}
                onChange={e => setTrendYear(Number(e.target.value))}
                className="bg-slate-700 border border-slate-600 text-white text-xs rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-orange-500/50">
                {[2024, 2025, 2026, 2027].map(year => <option key={year} value={year}>{year}</option>)}
              </select>
              <button data-tour-action="stock-open-master-modal" onClick={() => setShowForm(true)}
                className="bg-orange-500 hover:bg-orange-400 text-white text-sm font-semibold
                  px-4 py-2 rounded-xl transition-all shadow-lg shadow-orange-500/25">
                + Tambah Bahan
              </button>
            </div>
          </div>

          {filteredPriceTrends.length > 0 && (
            <div data-tour="stock-master-trends" className="space-y-3">
              <div data-tour="stock-master-trend-controls" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-700/50 bg-slate-800/50 px-4 py-3">
                <div>
                  <p className="text-sm font-bold text-white">
                    {trendCardsExpanded ? 'Semua card tren harga' : `Card tren ${trendCardPage * MASTER_TREND_CARD_PAGE_SIZE + 1}-${Math.min((trendCardPage + 1) * MASTER_TREND_CARD_PAGE_SIZE, filteredPriceTrends.length)}`}
                  </p>
                  <p className="text-xs text-slate-500">{filteredPriceTrends.length} bahan punya riwayat harga</p>
                </div>
                <button
                  type="button"
                  data-tour-action="stock-master-trend-toggle"
                  onClick={() => {
                    setTrendCardsExpanded((current) => !current);
                    setTrendCardPage(0);
                  }}
                  className="rounded-xl border border-orange-500/30 bg-orange-500/10 px-4 py-2 text-xs font-black text-orange-300 transition-all hover:bg-orange-500/20"
                >
                  {trendCardsExpanded ? 'Hide ke 8 card' : 'Expand semua card'}
                </button>
              </div>
              <div data-tour="stock-master-trend-cards" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {visibleTrendCards.map((trend) => {
                const yearTrend = getPercentTrend(trend.year_change_percent);
                const allTrend = getPercentTrend(trend.all_change_percent);
                return (
                  <div key={trend.id} className="bg-slate-800/80 border border-slate-700/60 rounded-2xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-white text-sm font-bold">{trend.name}</p>
                        <p className="text-slate-500 text-xs">{trend.unit}</p>
                      </div>
                      <span className="text-[10px] px-2 py-1 rounded-full bg-slate-700/70 text-slate-300">
                        {trend.all_purchase_count} pembelian
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <div className={`rounded-xl border p-3 ${yearTrend.bg}`}>
                        <p className="text-slate-500 text-[11px]">{trendYear}</p>
                        <p className={`text-sm font-black ${yearTrend.cls}`}>{yearTrend.icon} {yearTrend.label}</p>
                        <p className="text-slate-500 text-[11px] mt-1">
                          Rp {Number(trend.year_first_price || 0).toLocaleString('id-ID')} → Rp {Number(trend.year_last_price || 0).toLocaleString('id-ID')}
                        </p>
                      </div>
                      <div className={`rounded-xl border p-3 ${allTrend.bg}`}>
                        <p className="text-slate-500 text-[11px]">All</p>
                        <p className={`text-sm font-black ${allTrend.cls}`}>{allTrend.icon} {allTrend.label}</p>
                        <p className="text-slate-500 text-[11px] mt-1">
                          Rp {Number(trend.all_first_price || 0).toLocaleString('id-ID')} → Rp {Number(trend.all_last_price || 0).toLocaleString('id-ID')}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
              {!trendCardsExpanded && trendCardPageCount > 1 && (
                <div data-tour="stock-master-trend-pagination" className="flex flex-wrap items-center justify-center gap-2">
                  {Array.from({ length: trendCardPageCount }).map((_, pageIndex) => (
                    <button
                      key={pageIndex}
                      type="button"
                      onClick={() => setTrendCardPage(pageIndex)}
                      aria-label={`Lihat card tren bahan halaman ${pageIndex + 1}`}
                      className={`h-2.5 rounded-full transition-all ${
                        trendCardPage === pageIndex
                          ? 'w-8 bg-orange-400 shadow-lg shadow-orange-500/30'
                          : 'w-2.5 bg-slate-600 hover:bg-slate-400'
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {filteredStockItemsWithSummary.length === 0
            ? <div data-tour="stock-master-table" className="bg-slate-800/60 rounded-2xl border border-slate-700/40 py-12">
                <EmptyState icon="📦" title="Belum ada bahan baku" sub="Tambahkan bahan baku terlebih dahulu" />
              </div>
            : (
              <div data-tour="stock-master-table" className="bg-slate-800/80 rounded-2xl border border-slate-700/60 overflow-hidden">
                <div data-tour="stock-master-table-summary" className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/50 bg-slate-900/35 px-4 py-3">
                  <div>
                    <p className="text-sm font-bold text-white">
                      Baris bahan baku {getTableRangeText(filteredStockItemsWithSummary.length, masterTablePage, masterTablePageSize)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {filteredStockItemsWithSummary.length} total bahan baku tersimpan
                    </p>
                  </div>
                  <span className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300">
                    Halaman {masterTablePage + 1}/{masterTablePageCount}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/60 bg-slate-800/50">
                        {['Nama Bahan','Satuan','Min. Stok','Stok Saat Ini','Harga/Satuan','Status','Aksi'].map(h => (
                          <th key={h} className={thC}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleMasterItems.map((item, i) => (
                        <tr key={item.id} className={trC(getTableOffset(masterTablePage, masterTablePageSize) + i)}>
                          <td className={`${tdC} text-white font-semibold`}>{item.name}</td>
                          <td className={`${tdC} text-slate-400`}>{item.unit}</td>
                          <td className={`${tdC} text-slate-400`}>{item.min_stock} {item.unit}</td>
                          <td className={tdC}>
                            {item.display_stock === null ? (
                              // Still loading from main_stock query
                              <span className="text-slate-500 text-xs italic">Loading...</span>
                            ) : (
                              <span className={
                                item.display_stock === 0              ? 'text-red-400 font-bold' :
                                item.display_stock <= item.min_stock  ? 'text-yellow-400 font-bold'
                                                                      : 'text-white font-bold'
                              }>
                                {item.display_stock} {item.unit}
                              </span>
                            )}
                          </td>
                          <td className={`${tdC} text-slate-300`}>
                            {item.display_price_per > 0
                              ? (() => {
                                const latest = Number(item.display_latest_price || 0);
                                const trend = getPriceTrend(latest, item.display_price_per);
                                return (
                                  <div className="space-y-1">
                                    <p className="font-semibold">Avg Rp {item.display_price_per.toLocaleString('id-ID')}</p>
                                    {latest > 0 && (
                                      <p className="text-xs">
                                        <span className="text-slate-500">Terakhir </span>
                                        <span className="text-slate-300">Rp {latest.toLocaleString('id-ID')}</span>
                                        {trend && (
                                          <span className={`ml-1 font-semibold ${trend.cls}`}>
                                            {trend.icon} {trend.label}
                                          </span>
                                        )}
                                      </p>
                                    )}
                                  </div>
                                );
                              })()
                              : <span className="text-slate-600 text-xs">Belum ada pembelian</span>
                            }
                          </td>
                          <td className={tdC}>
                            {item.display_stock === null ? (
                              <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-slate-700 text-slate-400">⏳ Menunggu</span>
                            ) : (
                              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                                item.display_stock === 0             ? 'bg-red-500/15 text-red-400' :
                                item.display_stock <= item.min_stock ? 'bg-yellow-500/15 text-yellow-400' :
                                                                      'bg-green-500/15 text-green-400'
                              }`}>
                                {item.display_stock === 0 ? 'Habis' :
                                item.display_stock <= item.min_stock ? 'Menipis' : 'Aman'}
                              </span>
                            )}
                          </td>
                          <td className={tdC}>
                            <div className="flex gap-2">
                              <button onClick={() => {
                                setEditId(item.id);
                                setFormData({ name:item.name, unit:item.unit||'Pcs', min_stock:item.min_stock });
                                setShowForm(true);
                              }} className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white transition-all">
                                Edit
                              </button>
                              <button onClick={async () => {
                                const confirmed = await showConfirm(`Hapus "${item.name}"?`, {
                                  title: 'Hapus Bahan Baku',
                                  confirmText: 'Hapus',
                                  tone: 'danger',
                                });
                                if (!confirmed) return;
                                await deleteStockItem(item.id);
                                loadMaster(); loadSummary();
                              }} className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all">
                                Hapus
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div data-tour="stock-master-table-pagination">
                  <TablePagination
                    totalRows={filteredStockItemsWithSummary.length}
                    page={masterTablePage}
                    pageSize={masterTablePageSize}
                    onPageChange={setMasterTablePage}
                    onPageSizeChange={(size) => {
                      setMasterTablePageSize(size);
                      setMasterTablePage(0);
                    }}
                    label="bahan"
                  />
                </div>
              </div>
            )
          }
        </div>
      ))}

      {/* ── STOK GUDANG ── */}
      {tab==='main' && (
        warehouseInitialLoading ? (
          <StockWarehouseSkeleton mode={mainTab} />
        ) : (
        <div data-tour="stock-warehouse" className="space-y-4">
          <div data-tour="stock-warehouse-tabs" className="flex flex-wrap items-center gap-2">
            <SubTab data-tour-action="stock-subtab-summary" active={mainTab==='summary'} onClick={() => setMainTab('summary')}>📊 Saldo Stok</SubTab>
            <SubTab data-tour-action="stock-subtab-in" active={mainTab==='in'}      onClick={() => setMainTab('in')}>📥 Pemasukan</SubTab>
            <SubTab data-tour-action="stock-subtab-out" active={mainTab==='out'}     onClick={() => setMainTab('out')}>📤 Pengeluaran</SubTab>
            <input
              value={warehouseSearch}
              onChange={(e) => {
                setWarehouseSearch(e.target.value);
              }}
              placeholder="Cari stok gudang..."
              className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-white outline-none placeholder:text-slate-500 focus:border-orange-500/60 sm:w-56"
            />
            {mainTab === 'in' && (
              <button
                data-tour-action="stock-open-purchase-modal"
                onClick={() => setShowPurchase(true)}
                className="ml-auto px-4 py-2 rounded-xl text-xs font-semibold
                  bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-all">
                + Catat Pembelian
              </button>
            )}
          </div>

          {/* Saldo */}
          {mainTab==='summary' && (
            <div data-tour="stock-summary" className="space-y-4">
              <div data-tour="stock-summary-cards" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { label:'Total Nilai Masuk',  val:`Rp ${totalIn.toLocaleString('id-ID')}`,          color:'text-blue-400',  bg:'bg-blue-500'  },
                  { label:'Total Nilai Keluar', val:`Rp ${totalOut.toLocaleString('id-ID')}`,          color:'text-red-400',   bg:'bg-red-500'   },
                  { label:'Nilai Stok Gudang',  val:`Rp ${(totalIn-totalOut).toLocaleString('id-ID')}`,color:'text-green-400', bg:'bg-green-500' },
                ].map((s,i) => (
                  <div key={i} className="relative bg-slate-800/80 rounded-2xl p-4 border border-slate-700/60 overflow-hidden">
                    <div className={`absolute top-0 right-0 w-16 h-16 rounded-full blur-2xl opacity-10 ${s.bg}`}/>
                    <p className="text-slate-500 text-xs relative">{s.label}</p>
                    <p className={`text-xl font-black mt-1 relative ${s.color}`}>{s.val}</p>
                  </div>
                ))}
              </div>
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3 flex gap-2.5">
                <span className="text-blue-400 shrink-0">ℹ</span>
                <p className="text-slate-500 text-xs leading-relaxed">
                  Cabang: <span className="text-slate-300 font-semibold">{selectedBranchName}</span>. Data saldo dihitung otomatis dari semua pemasukan dan pengeluaran (via pengajuan kasir yang disetujui).
                  Tidak ada input manual di halaman ini.
                </p>
              </div>
              <div data-tour="stock-summary-table" className="bg-slate-800/80 rounded-2xl border border-slate-700/60 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/60 bg-slate-800/30">
                        {['Bahan Baku','Satuan','Total Masuk','Total Keluar','Saldo Stok','Status'].map(h => <th key={h} className={thC}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSummary.length===0
                        ? <tr><td colSpan={6}><EmptyState title="Belum ada data stok" sub="Catat pembelian di tab Pemasukan" /></td></tr>
                        : visibleSummaryRows.map((row,i) => {
                          const cur = Number(row.current_stock);
                          return (
                            <tr key={row.id} className={trC(getTableOffset(summaryTablePage, summaryTablePageSize) + i)}>
                              <td className={`${tdC} text-white font-semibold`}>{row.name}</td>
                              <td className={`${tdC} text-slate-400`}>{row.unit}</td>
                              <td className={tdC}>
                                <span className="text-blue-400 font-semibold">{fmtQty(row.total_in)}</span>
                                <span className="text-slate-600 text-xs ml-1.5">(Rp {Number(row.total_cost_in).toLocaleString('id-ID')})</span>
                              </td>
                              <td className={tdC}>
                                <span className="text-red-400 font-semibold">{fmtQty(row.total_out)}</span>
                                <span className="text-slate-600 text-xs ml-1.5">(Rp {Number(row.total_cost_out).toLocaleString('id-ID')})</span>
                              </td>
                              <td className={tdC}>
                                <span className={`font-bold ${cur===0?'text-red-400':cur<=row.min_stock?'text-yellow-400':'text-white'}`}>
                                  {fmtQty(cur)} {row.unit}
                                </span>
                              </td>
                              <td className={tdC}>
                                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                                  cur===0?'bg-red-500/15 text-red-400':cur<=row.min_stock?'bg-yellow-500/15 text-yellow-400':'bg-green-500/15 text-green-400'
                                }`}>
                                  {cur===0?'Habis':cur<=row.min_stock?'Menipis':'Aman'}
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      }
                    </tbody>
                  </table>
                </div>
                <TablePagination
                  totalRows={filteredSummary.length}
                  page={summaryTablePage}
                  pageSize={summaryTablePageSize}
                  onPageChange={setSummaryTablePage}
                  onPageSizeChange={(size) => {
                    setSummaryTablePageSize(size);
                    setSummaryTablePage(0);
                  }}
                  label="saldo"
                />
              </div>
            </div>
          )}

          {/* Pemasukan */}
          {mainTab === 'in' && (
            <div data-tour="stock-in" className="space-y-3">
              <div data-tour="stock-in-filters" className="grid gap-3 md:grid-cols-[minmax(0,380px)_1fr]">
                <DateRangePicker
                  label="Range pemasukan"
                  value={{ start: stockInDateFrom, end: stockInDateTo }}
                  onChange={({ start, end }) => {
                    setStockInDateFrom(start);
                    setStockInDateTo(end);
                    if (start) {
                      const date = new Date(`${start}T00:00:00`);
                      if (!Number.isNaN(date.getTime())) {
                        setSelMonth(date.getMonth() + 1);
                        setSelYear(date.getFullYear());
                      }
                    }
                  }}
                  helperText="Klik tanggal awal pemasukan, lalu tanggal akhir"
                />

                {/* ── Tab filter bahan baku ── */}
                <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setFilterItemId(null)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                      filterItemId === null
                        ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                        : 'bg-slate-700/60 text-slate-400 border border-slate-600/60 hover:text-white hover:border-slate-500'
                    }`}>
                    Semua
                    <span className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                      filterItemId === null ? 'bg-white/20 text-white' : 'bg-slate-600 text-slate-300'
                    }`}>
                      {searchedInData.length}
                    </span>
                  </button>

                  {visibleStockInFilterNames.map(name => {
                    const count    = searchedInData.filter(r => r.item_name === name).length;
                    const isActive = filterItemId === name;
                    return (
                      <button key={name} onClick={() => setFilterItemId(isActive ? null : name)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                          isActive
                            ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                            : 'bg-slate-700/60 text-slate-400 border border-slate-600/60 hover:text-white hover:border-slate-500'
                        }`}>
                        {name}
                        <span className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                          isActive ? 'bg-white/20 text-white' : 'bg-slate-600 text-slate-300'
                        }`}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {stockInFilterNames.length > STOCK_IN_FILTER_PAGE_SIZE && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-700/50 bg-slate-900/35 px-3 py-2">
                    <p className="text-xs text-slate-500">
                      {stockInFilterExpanded
                        ? `Semua ${stockInFilterNames.length} filter bahan tampil`
                        : `Filter bahan ${stockInFilterPage * STOCK_IN_FILTER_PAGE_SIZE + 1}-${Math.min((stockInFilterPage + 1) * STOCK_IN_FILTER_PAGE_SIZE, stockInFilterNames.length)} dari ${stockInFilterNames.length}`}
                    </p>
                    <div className="flex items-center gap-2">
                      {!stockInFilterExpanded && stockInFilterPageCount > 1 && (
                        <div className="flex items-center gap-1.5">
                          {Array.from({ length: stockInFilterPageCount }).map((_, pageIndex) => (
                            <button
                              key={pageIndex}
                              type="button"
                              onClick={() => setStockInFilterPage(pageIndex)}
                              aria-label={`Lihat filter pemasukan halaman ${pageIndex + 1}`}
                              className={`h-2 rounded-full transition-all ${
                                stockInFilterPage === pageIndex
                                  ? 'w-7 bg-orange-400 shadow-lg shadow-orange-500/30'
                                  : 'w-2 bg-slate-600 hover:bg-slate-400'
                              }`}
                            />
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setStockInFilterExpanded((current) => !current);
                          setStockInFilterPage(0);
                        }}
                        className="rounded-xl border border-orange-500/30 bg-orange-500/10 px-3 py-1.5 text-xs font-black text-orange-300 transition-all hover:bg-orange-500/20"
                      >
                        {stockInFilterExpanded ? 'Hide ke 10 filter' : 'Expand filter'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              </div>

              <div data-tour="stock-in-table" className="bg-slate-800/80 rounded-2xl border border-slate-700/60 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/60 bg-slate-800/30">
                        {['Tanggal','Bahan Baku','Jumlah','Harga/Satuan','Total Biaya','Harga Avg','Catatan','Dicatat Oleh','Aksi'].map(h => (
                          <th key={h} className={thC}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        if (filteredInRows.length === 0)
                          return <tr><td colSpan={9}><EmptyState title="Belum ada pemasukan bulan ini" /></td></tr>;
                        return visibleStockInRows.map((row, i) => (
                          <tr key={row.id} className={trC(getTableOffset(stockInTablePage, stockInTablePageSize) + i)}>
                            <td className={`${tdC} text-slate-400 text-xs whitespace-nowrap`}>
                              {new Date(row.created_at).toLocaleDateString('id-ID', { day:'numeric', month:'short', year:'numeric' })}
                            </td>
                            <td className={`${tdC} text-white font-medium`}>{row.item_name}</td>
                            <td className={`${tdC} text-blue-400 font-semibold`}>{fmtQty(row.qty)} {row.unit}</td>
                            <td className={`${tdC} text-slate-300`}>Rp {Number(row.cost_per_unit).toLocaleString('id-ID')}</td>
                            <td className={`${tdC} text-green-400 font-bold`}>Rp {Number(row.total_cost).toLocaleString('id-ID')}</td>
                            <td className={`${tdC} text-xs`}>
                              {(() => {
                                const s = summary.find(sm => sm.name === row.item_name);
                                if (!s || !Number(s.price_per_unit)) return <span className="text-slate-600">—</span>;
                                const isHigher = Number(row.cost_per_unit) > Number(s.price_per_unit);
                                const isLower  = Number(row.cost_per_unit) < Number(s.price_per_unit);
                                return (
                                  <div>
                                    <span className="text-slate-300">Rp {Number(s.price_per_unit).toLocaleString('id-ID')}</span>
                                    {isHigher && <span className="text-red-400 text-xs ml-1">↑ Naik</span>}
                                    {isLower  && <span className="text-green-400 text-xs ml-1">↓ Turun</span>}
                                  </div>
                                );
                              })()}
                            </td>
                            <td className={`${tdC} text-slate-500 text-xs`}>{row.note || '—'}</td>
                            <td className={`${tdC} text-slate-400 text-xs`}>{row.created_by_name}</td>
                            <td className={tdC}>
                              <div className="flex gap-2">
                                <button onClick={() => setEditPurchase(row)}
                                  className="text-xs px-2.5 py-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white transition-all">
                                  Edit
                                </button>
                                <button
                                  onClick={async () => {
                                    const confirmed = await showConfirm(`Hapus data pembelian ${row.item_name}?`, {
                                      title: 'Hapus Pembelian Stok',
                                      confirmText: 'Hapus',
                                      tone: 'danger',
                                    });
                                    if (!confirmed) return;
                                    try {
                                      await deleteStockPurchase(row.id);
                                      loadMonthly(); loadSummary(); loadMaster();
                                    } catch(e) { alert(e.response?.data?.message || 'Gagal menghapus'); }
                                  }}
                                  className="text-xs px-2.5 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all">
                                  Hapus
                                </button>
                              </div>
                            </td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                </div>
                <TablePagination
                  totalRows={filteredInRows.length}
                  page={stockInTablePage}
                  pageSize={stockInTablePageSize}
                  onPageChange={setStockInTablePage}
                  onPageSizeChange={(size) => {
                    setStockInTablePageSize(size);
                    setStockInTablePage(0);
                  }}
                  label="pemasukan"
                />
              </div>
            </div>
          )}

          {/* Pengeluaran */}
          {mainTab === 'out' && (
            <div data-tour="stock-out" className="space-y-3">
              {/* Filter date + tombol */}
              <div data-tour="stock-out-filters" className="flex justify-end">
                <div className="w-full max-w-sm lg:ml-auto">
                  <DateRangePicker
                    label="Range pengeluaran"
                    value={{ start: selDate, end: selDateTo || selDate }}
                    onChange={({ start, end }) => {
                      setSelDate(start);
                      setSelDateTo(end || start);
                    }}
                    helperText="Klik tanggal awal pengeluaran, lalu tanggal akhir"
                  />
                </div>
              </div>

              {/* ── Filter pills ── */}
              <div data-tour="stock-out-pills" className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1.5 items-center">
                  {OUT_FILTERS.map(f => (
                    <button key={f.val}
                      onClick={() => setOutTypeFilter(f.val)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                        outTypeFilter === f.val
                          ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                          : 'bg-slate-700/60 text-slate-400 border border-slate-600/60 hover:text-white hover:border-slate-500'
                      }`}>
                      {f.label}
                    </button>
                  ))}
                  <span className="text-slate-600 text-xs ml-1">{searchedOutData.length} data</span>
                </div>
                <button
                  data-tour-action="stock-open-out-modal"
                  onClick={() => {
                    setOutMenuSelections([createEmptyRecipeSelection()]);
                    setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                    setShowOutForm(true);
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-semibold
                    bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-all">
                  + Catat Pengeluaran
                </button>
              </div>

              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3 flex gap-2.5">
                <span className="text-yellow-400 shrink-0">ℹ</span>
                <p className="text-slate-500 text-xs">
                  Cabang: <span className="text-slate-300 font-semibold">{selectedBranchName}</span>. Termasuk pengeluaran otomatis dari transaksi POS dan pengajuan manual kasir.
                </p>
              </div>

              {/* Tabel */}
              <div data-tour="stock-out-table" className="bg-slate-800/80 rounded-2xl border border-slate-700/60 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/60 bg-slate-800/30">
                        {['Tanggal','Bahan Baku','Jumlah','Harga/Sat','Total Nilai','Status Sumber','Sumber Cabang','Sumber Stok','Pengaju','Status','Catatan'].map(h => (
                          <th key={h} className={thC}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {searchedOutData.length === 0
                        ? <tr><td colSpan={11}><EmptyState title="Tidak ada data pengeluaran" /></td></tr>
                        : visibleStockOutRows.map((row, i) => {
                          const isPending  = row.type === 'pending_out' && row.request_status === 'pending';
                          const isRejected = row.type === 'pending_out' && row.request_status === 'rejected';
                          const isTx       = row.type === 'transaction';
                          const isApproved = !isPending && !isRejected;

                          return (
                            <tr key={`${row.id}-${i}`} className={trC(getTableOffset(stockOutTablePage, stockOutTablePageSize) + i)}>
                              <td className={`${tdC} text-slate-400 text-xs whitespace-nowrap`}>
                                {new Date(row.created_at).toLocaleDateString('id-ID', {
                                  day:'numeric', month:'short', year:'numeric'
                                })}
                              </td>
                              <td className={`${tdC} text-white font-medium`}>{row.item_name}</td>
                              <td className={`${tdC} font-semibold ${isApproved ? 'text-red-400' : 'text-slate-400'}`}>
                                {fmtQty(row.qty)} {row.unit}
                              </td>
                              <td className={`${tdC} text-slate-300`}>
                                Rp {Number(row.cost_per_unit).toLocaleString('id-ID')}
                              </td>
                              <td className={`${tdC} font-bold ${isApproved ? 'text-red-400' : 'text-slate-500'}`}>
                                Rp {Number(row.total_cost).toLocaleString('id-ID')}
                              </td>

                              {/* Kolom Status Sumber */}
                              <td className={tdC}>
                                <TypeBadge type={row.type} status={row.request_status} />
                              </td>
                              <td className={`${tdC} text-slate-300 text-xs`}>
                                {row.branch_name || 'Cabang aktif'}
                              </td>

                              {/* Kolom Sumber Stok */}
                              <td className={`${tdC} text-slate-300 text-xs`}>
                                {row.stock_owner_name || row.target_user_name || row.created_by_name || '—'}
                              </td>

                              {/* ✅ SESUDAH */}
<td className={tdC}>
  {row.admin_name ? (
    // Admin yang input transaksi menggunakan stok kasir
    <span className="text-xs text-blue-400/80 font-bold">
      {row.admin_name}
    </span>
  ) : (
    // Kasir transaksi sendiri
    <span className="text-xs text-slate-400">
      {row.created_by_name || '—'}
    </span>
  )}
</td>

                              {/* Kolom Status */}
                              <td className={tdC}>
                                {isTx && (
                                  <span className="text-xs px-2 py-1 rounded-full font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/20">
                                    ✓ Terjual
                                  </span>
                                )}
                                {!isTx && isApproved && (
                                  <span className="text-xs px-2 py-1 rounded-full font-semibold bg-green-500/15 text-green-400 border border-green-500/20">
                                    ✓ Disetujui
                                  </span>
                                )}
                                {isPending && (
                                  <span className="text-xs px-2 py-1 rounded-full font-semibold bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
                                    ⏳ Menunggu
                                  </span>
                                )}
                                {isRejected && (
                                  <div className="space-y-1">
                                    <span className="text-xs px-2 py-1 rounded-full font-semibold bg-red-500/15 text-red-400 border border-red-500/20 block w-fit">
                                      ✕ Ditolak
                                    </span>
                                    <button onClick={() => { setTab('requests'); setReqStatus('rejected'); }}
                                      className="text-xs text-orange-400 hover:text-orange-300 underline">
                                      Ajukan ulang →
                                    </button>
                                  </div>
                                )}
                              </td>

                              <td className={`${tdC} text-slate-500 text-xs`}>{row.note || '—'}</td>
                            </tr>
                          );
                        })
                      }
                    </tbody>
                  </table>
                </div>
                <TablePagination
                  totalRows={searchedOutData.length}
                  page={stockOutTablePage}
                  pageSize={stockOutTablePageSize}
                  onPageChange={setStockOutTablePage}
                  onPageSizeChange={(size) => {
                    setStockOutTablePageSize(size);
                    setStockOutTablePage(0);
                  }}
                  label="pengeluaran"
                />
              </div>
            </div>
          )}
        </div>
      ))}

      {/* ── PENGAJUAN KASIR ── */}
      {tab==='requests' && (
        requestsInitialLoading ? (
          <StockRequestSkeleton />
        ) : (
        <div data-tour="stock-requests" className="space-y-4">
          <div data-tour="stock-request-filters" className="space-y-3">
            <div className="flex justify-end">
              <div className="w-full max-w-sm lg:ml-auto">
              <DateRangePicker
                label="Range pengajuan"
                value={{ start: reqDateFrom2, end: reqDateTo2 }}
                onChange={({ start, end }) => {
                  setReqDateFrom2(start);
                  setReqDateTo2(end || start);
                }}
                helperText="Klik tanggal awal pengajuan, lalu tanggal akhir"
              />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {STOCK_REQUEST_FILTERS.map(({ val, label }) => (
                  <button key={val || 'all'} onClick={() => setReqStatus(val)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                      reqStatus === val
                        ? 'bg-orange-500 text-white'
                        : 'bg-slate-800 text-slate-400 border border-slate-700 hover:text-white'
                    }`}>
                    {label}
                  </button>
                ))}
                <span className="text-slate-600 text-xs">{filteredRequests.length} pengajuan</span>
              </div>
              <input
                value={requestSearch}
                onChange={(e) => setRequestSearch(e.target.value)}
                placeholder="Cari pengajuan..."
                className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-white outline-none placeholder:text-slate-500 focus:border-orange-500/60 sm:w-64"
              />
            </div>
          </div>

          {filteredRequests.length===0
            ? <div data-tour="stock-request-list" className="bg-slate-800/60 rounded-2xl border border-slate-700/40 py-12">
                <EmptyState icon="📋" title="Tidak ada pengajuan" sub="Kasir belum mengajukan stok" />
              </div>
            : filteredRequests.map(req => (
              <div key={req.id} data-tour="stock-request-list" className="bg-slate-800/80 rounded-2xl border border-slate-700/60 overflow-hidden">
                <div className="flex flex-wrap items-start justify-between gap-3 p-4 border-b border-slate-700/40">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-400 text-sm font-bold">
                        {req.user_name?.charAt(0)?.toUpperCase()}
                      </div>
                      <p className="text-white font-bold text-sm">{req.user_name}</p>
                      <StatusBadge status={req.status} />
                    </div>
                    <p className="text-slate-500 text-xs mt-1 ml-10">
                      {new Date(req.date).toLocaleDateString('id-ID', {
                        weekday:'long', day:'numeric', month:'long', year:'numeric'
                      })}
                    </p>
                    {req.created_by_admin_name && (
                      <p className="text-blue-400/70 text-xs mt-0.5 ml-10">
                        📝 Dibuat oleh: <span className="text-blue-400">{req.created_by_admin_name}</span>
                      </p>
                    )}
                    {req.approved_by_name && (
                      <p className="text-slate-600 text-xs mt-0.5 ml-10">
                        Diproses: <span className="text-slate-400">{req.approved_by_name}</span>
                      </p>
                    )}
                  </div>

                  {/* Tombol aksi sesuai status */}
                  <div className="flex gap-2 flex-wrap shrink-0">
                    {/* Pending → bisa diproses approve */}
                    {req.status === 'pending' && (
                      <button
                        onClick={() => {
                          setApproveModal(req);
                          setApproveItems(req.items.map(i => ({ ...i, qty_approved: i.qty_requested })));
                        }}
                        className="px-4 py-2 rounded-xl text-xs font-semibold
                          bg-orange-500/20 text-orange-400 border border-orange-500/30
                          hover:bg-orange-500/30 transition-all">
                        Proses →
                      </button>
                    )}

                    {/* Rejected → bisa diajukan ulang oleh admin */}
                    {req.status === 'rejected' && (
                      <button
                        onClick={async () => {
                          const confirmed = await showConfirm(`Ajukan ulang pengajuan ${req.user_name}?`, {
                            title: 'Ajukan Ulang Stok',
                            confirmText: 'Ajukan Ulang',
                            tone: 'warning',
                          });
                          if (!confirmed) return;
                          try {
                            await resubmitStockRequest(req.id);
                            loadRequests();
                          } catch(e) {
                            alert(e.response?.data?.message || 'Gagal mengajukan ulang');
                          }
                        }}
                        className="px-4 py-2 rounded-xl text-xs font-semibold
                          bg-blue-500/20 text-blue-400 border border-blue-500/30
                          hover:bg-blue-500/30 transition-all">
                        🔄 Ajukan Ulang
                      </button>
                    )}
                  </div>
                </div>

                {/* Items table with approved values */}
                {req.items?.length > 0 && (
                  <div className="overflow-x-auto px-4 py-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-700/40">
                          {['Bahan','Diajukan','Disetujui','Harga/Sat','Nilai Diajukan','Nilai Disetujui'].map(h => (
                            <th key={h} className="text-left text-slate-600 py-1.5 pr-4 font-semibold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {req.items.map(item => (
                          <tr key={item.id} className="border-b border-slate-700/20">
                            <td className="py-1.5 pr-4 text-slate-300 font-medium">
                              {item.item_name} <span className="text-slate-600">({item.unit})</span>
                            </td>
                            <td className="py-1.5 pr-4 text-slate-400">{Number(item.qty_requested).toFixed(2)}</td>
                            <td className="py-1.5 pr-4">
                              {item.qty_approved != null
                                ? <span className="text-green-400 font-semibold">{Number(item.qty_approved).toFixed(2)}</span>
                                : <span className="text-slate-700">—</span>}
                            </td>
                            <td className="py-1.5 pr-4 text-slate-400">
                              Rp {Number(item.cost_per_unit).toLocaleString('id-ID')}
                            </td>
                            <td className="py-1.5 text-orange-400">
                              Rp {(Number(item.qty_requested) * Number(item.cost_per_unit)).toLocaleString('id-ID')}
                            </td>
                            <td className="py-1.5">
                              {item.qty_approved != null
                                ? <span className="text-green-400 font-semibold">
                                    Rp {(Number(item.qty_approved) * Number(item.cost_per_unit)).toLocaleString('id-ID')}
                                  </span>
                                : <span className="text-slate-700">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={4} className="pt-2 text-slate-600 text-xs font-semibold">Total</td>
                          <td className="pt-2 text-orange-400 font-bold">
                            Rp {req.items.reduce((s, i) =>
                              s + Number(i.qty_requested) * Number(i.cost_per_unit), 0
                            ).toLocaleString('id-ID')}
                          </td>
                          <td className="pt-2 text-green-400 font-bold">
                            Rp {req.items.reduce((s, i) =>
                              s + (Number(i.qty_approved || 0) * Number(i.cost_per_unit)), 0
                            ).toLocaleString('id-ID')}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            ))
          }
        </div>
      ))}

      {tab==='issues' && <StockIssuesTab />}

      {/* ══ MODAL: TAMBAH/EDIT BAHAN BAKU ══ */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div data-tour="stock-master-modal" className="bg-slate-800 rounded-2xl p-6 w-full max-w-md border border-slate-700 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-white font-bold text-lg">{editId?'Edit':'Tambah'} Bahan Baku</h2>
              <button data-tour-action="stock-close-master-modal" onClick={resetForm} className="text-slate-500 hover:text-white p-1 rounded-lg hover:bg-slate-700">✕</button>
            </div>
            {!editId && (
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 mb-4">
                <p className="text-blue-400 text-xs">💡 Hanya daftarkan nama & satuan. Tambah stok via <strong>Stok Gudang → Catat Pembelian</strong>.</p>
              </div>
            )}
            <div className="space-y-4">
              <div data-tour="stock-master-name-field">
                <label className="text-slate-400 text-sm block mb-1">Nama Bahan <span className="text-red-400">*</span></label>
                <input value={formData.name} onChange={e => setFormData(p=>({...p,name:e.target.value}))}
                  placeholder="contoh: Slice Beef, Cup, Saus Sambal..."
                  className="w-full bg-slate-700 text-white rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500 border border-slate-600 placeholder:text-slate-500" />
              </div>
              <div data-tour="stock-master-unit-field">
                <label className="text-slate-400 text-sm block mb-1">Satuan <span className="text-red-400">*</span></label>
                <select value={formData.unit} onChange={e => setFormData(p=>({...p,unit:e.target.value}))}
                  className="w-full bg-slate-700 text-white rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500 border border-slate-600">
                  {UNIT_GROUPS.map(g => (
                    <optgroup key={g.label} label={`── ${g.label} ──`}>
                      {g.units.map(u => <option key={u} value={u}>{u}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div data-tour="stock-master-min-field">
                <label className="text-slate-400 text-sm block mb-1">Min. Stok Alert <span className="text-slate-600 text-xs">(opsional)</span></label>
                <div className="relative">
                  <input type="number" min="0" value={formData.min_stock}
                    onChange={e => setFormData(p=>({...p,min_stock:e.target.value}))}
                    placeholder="0"
                    className="w-full bg-slate-700 text-white rounded-xl px-4 py-3 pr-16 outline-none focus:ring-2 focus:ring-orange-500 border border-slate-600" />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">{formData.unit}</span>
                </div>
              </div>
              <div data-tour="stock-master-actions-field" className="flex gap-3 pt-2">
                <button onClick={resetForm} className="flex-1 bg-slate-700 hover:bg-slate-600 text-white rounded-xl py-3 text-sm font-semibold">Batal</button>
                <button data-tour="stock-master-save-button" onClick={handleSaveMaster} disabled={formLoading||!formData.name.trim()}
                  className="flex-1 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white font-bold rounded-xl py-3 text-sm">
                  {formLoading?'Menyimpan...':editId?'Update':'Simpan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL: CATAT PEMBELIAN ══ */}
      {showPurchase && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div data-tour="stock-purchase-modal" className="bg-slate-800 rounded-2xl border border-slate-700 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-slate-700/60">
              <div>
                <h3 className="text-white font-bold">📥 Catat Pembelian Stok</h3>
                <p className="text-slate-500 text-xs mt-0.5">Stok gudang akan bertambah otomatis</p>
              </div>
              <button data-tour-action="stock-close-purchase-modal" onClick={() => setShowPurchase(false)} className="text-slate-500 hover:text-white p-2 rounded-xl hover:bg-slate-700 transition-colors">✕</button>
            </div>
            <div className="p-5 space-y-3">
              {purchItems.map((item, i) => (
                <div key={i} data-tour="stock-purchase-item" className="bg-slate-700/40 rounded-xl p-4 border border-slate-600/40">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-slate-400 text-xs font-semibold uppercase tracking-wide">Item {i+1}</span>
                    {purchItems.length>1 && (
                      <button onClick={() => setPurchItems(p => p.filter((_,j) => j!==i))}
                        className="text-red-400 hover:text-red-300 text-xs">Hapus</button>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div data-tour="stock-purchase-select-field">
                      <label className="text-slate-500 text-xs mb-1 block">Pilih Bahan Baku</label>
                      <select value={item.stock_item_id}
                        onChange={e => setPurchItems(p => p.map((x,j) => j===i?{...x,stock_item_id:e.target.value}:x))}
                        className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50">
                        <option value="">-- Pilih bahan --</option>
                        {stockItems.map(si => <option key={si.id} value={si.id}>{si.name} ({si.unit})</option>)}
                      </select>
                    </div>
                    <div data-tour="stock-purchase-qty-cost-field" className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-slate-500 text-xs mb-1 block">
                          Jumlah {item.stock_item_id ? `(${stockItems.find(s=>s.id==item.stock_item_id)?.unit||''})` : ''}
                        </label>
                        <input type="number" min="0" value={item.qty} placeholder="0"
                          onChange={e => setPurchItems(p => p.map((x,j) => j===i?{...x,qty:e.target.value}:x))}
                          className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50 placeholder:text-slate-600" />
                      </div>
                      <div>
                        <label className="text-slate-500 text-xs mb-1 block">Harga / Satuan (Rp)</label>
                        <input type="number" min="0" value={item.cost_per_unit} placeholder="0"
                          onChange={e => setPurchItems(p => p.map((x,j) => j===i?{...x,cost_per_unit:e.target.value}:x))}
                          className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50 placeholder:text-slate-600" />
                      </div>
                    </div>
                    {Number(item.qty)>0 && Number(item.cost_per_unit)>0 && (
                      <div data-tour="stock-purchase-subtotal" className="bg-orange-500/10 rounded-lg px-3 py-2 flex justify-between">
                        <span className="text-slate-500 text-xs">Subtotal</span>
                        <span className="text-orange-400 text-xs font-bold">
                          Rp {(Number(item.qty)*Number(item.cost_per_unit)).toLocaleString('id-ID')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <button data-tour="stock-purchase-add-item" onClick={() => setPurchItems(p => [...p,{stock_item_id:'',qty:'',cost_per_unit:''}])}
                className="w-full py-2.5 rounded-xl border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-500 text-sm transition-all">
                + Tambah Bahan Lain
              </button>
              <div data-tour="stock-purchase-note-field">
                <label className="text-slate-500 text-xs mb-1 block">Catatan (opsional)</label>
                <input value={purchNote} onChange={e => setPurchNote(e.target.value)}
                  placeholder="contoh: Pembelian dari pasar..."
                  className="w-full bg-slate-700 border border-slate-600 text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50 placeholder:text-slate-600" />
              </div>
              <div data-tour="stock-purchase-total" className="bg-slate-700/60 rounded-xl p-4 border border-slate-600/40 flex justify-between items-center">
                <div>
                  <p className="text-slate-400 text-xs">Total Pembelian</p>
                  <p className="text-slate-600 text-xs">{purchItems.filter(i=>i.stock_item_id).length} item</p>
                </div>
                <p className="text-white font-black text-xl">
                  Rp {purchItems.reduce((s,i) => s+(Number(i.qty)*Number(i.cost_per_unit)||0),0).toLocaleString('id-ID')}
                </p>
              </div>
            </div>
            <div data-tour="stock-purchase-actions" className="flex gap-3 p-5 pt-0">
              <button onClick={() => setShowPurchase(false)}
                className="flex-1 py-3 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm font-semibold">Batal</button>
              <button data-tour="stock-purchase-save-button" onClick={handlePurchase} disabled={purchLoading}
                className="flex-1 py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold disabled:opacity-50">
                {purchLoading?'Menyimpan...':'💾 Simpan Pembelian'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL: EDIT PEMBELIAN ══ */}
      {editPurchase && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-slate-700 w-full max-w-md">
            <div className="flex items-center justify-between p-5 border-b border-slate-700/60">
              <div>
                <h3 className="text-white font-bold">✏️ Edit Pembelian</h3>
                <p className="text-slate-500 text-xs mt-0.5">{editPurchase.item_name}</p>
              </div>
              <button onClick={() => setEditPurchase(null)}
                className="text-slate-500 hover:text-white p-2 rounded-xl hover:bg-slate-700">✕</button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-slate-400 text-xs block mb-1">Jumlah ({editPurchase.unit})</label>
                <input type="number" min="0"
                  defaultValue={fmtQty(editPurchase.qty)}
                  id="edit-qty"
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded-xl px-4 py-3
                    outline-none focus:ring-2 focus:ring-orange-500/50" />
              </div>
              <div>
                <label className="text-slate-400 text-xs block mb-1">Harga / Satuan (Rp)</label>
                <input type="number" min="0"
                  defaultValue={fmtQty(editPurchase.cost_per_unit)}
                  id="edit-cost"
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded-xl px-4 py-3
                    outline-none focus:ring-2 focus:ring-orange-500/50" />
              </div>
              <div>
                <label className="text-slate-400 text-xs block mb-1">Catatan (opsional)</label>
                <input type="text"
                  defaultValue={editPurchase.note || ''}
                  id="edit-note"
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded-xl px-4 py-3
                    outline-none focus:ring-2 focus:ring-orange-500/50 placeholder:text-slate-600"
                  placeholder="Catatan pembelian..." />
              </div>
            </div>
            <div className="flex gap-3 p-5 pt-0">
              <button onClick={() => setEditPurchase(null)}
                className="flex-1 py-3 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm font-semibold">
                Batal
              </button>
              <button
                data-tour="stock-out-save-button"
                onClick={async () => {
                  const qty  = Number(document.getElementById('edit-qty').value);
                  const cost = Number(document.getElementById('edit-cost').value);
                  const note = document.getElementById('edit-note').value;
                  if (!qty || !cost) return alert('Jumlah dan harga wajib diisi');
                  try {
                    await updateStockPurchase(editPurchase.id, { qty, cost_per_unit: cost, note });
                    setEditPurchase(null);
                    loadMonthly(); loadSummary(); loadMaster();
                  } catch(e) { alert(e.response?.data?.message || 'Gagal'); }
                }}
                className="flex-1 py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold">
                Simpan Perubahan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL: CATAT PENGELUARAN MANUAL ══ */}
      {showOutForm && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div data-tour="stock-out-modal" className="bg-slate-800 rounded-2xl border border-slate-700 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <button
              type="button"
              data-tour-action="stock-close-out-modal"
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => {
                setShowOutForm(false);
                setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                setOutUserId('');
                setOutMenuSelections([createEmptyRecipeSelection()]);
              }}
            />
            <div className="flex items-center justify-between p-5 border-b border-slate-700/60">
              <div>
                <h3 className="text-white font-bold">📤 Catat Pengeluaran Stok</h3>
                <p className="text-slate-500 text-xs mt-0.5">
                  Hanya bahan yang ada di gudang · Tidak boleh melebihi stok tersedia
                </p>
              </div>
              <button onClick={() => {
                // Ganti pesan sukses setelah submit
                setShowOutForm(false);
                setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                setOutUserId('');
                setOutMenuSelections([createEmptyRecipeSelection()]);
                // Redirect ke tab pengajuan supaya admin bisa lihat & approve
                setTab('requests');
                loadRequests();
                setSuccessModal({
                  isOpen: true,
                  title: 'Pengeluaran Tercatat',
                  message: 'Pengajuan pengeluaran berhasil dibuat. Silakan approve di tab Pengajuan Kasir.',
                  requestType: 'withdrawal',
                });
              }}
                className="text-slate-500 hover:text-white p-2 rounded-xl hover:bg-slate-700 transition-colors">
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* ── Pilih kasir (hanya admin) ── */}
              <div data-tour="stock-out-user-field">
                <label className="text-slate-400 text-xs font-semibold block mb-1.5">
                  Kasir / Pengguna <span className="text-red-400">*</span>
                </label>
                <select
                  value={outUserId}
                  onChange={e => setOutUserId(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 text-white text-sm
                    rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50">
                  <option value="">-- Pilih kasir --</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role})
                    </option>
                  ))}
                </select>
              </div>

              {/* ── Items ── */}
              <RecipeMenuPicker
                products={productOptions}
                stockRows={summary}
                selections={outMenuSelections}
                title="Buat stok dari menu"
                onSelectionsChange={syncOutRecipeSelections}
              />

              {hasOutMenuSelection ? (
                <ReadOnlyRecipeSummary rows={outRecipeRows} title={`Ringkasan bahan untuk ${outRecipeSelectionLabel || 'menu terpilih'}`} />
              ) : (
              <div data-tour="stock-out-manual-list" className="space-y-3">
                {outItems.map((item, i) => {
                  const si      = summary.find(s => s.id == item.stock_item_id);
                  const maxStok = si ? Number(si.current_stock) : 0;
                  // Pakai latest_cost_per_unit kalau price_per_unit belum diupdate
                  // const harga   = Number(si?.latest_cost_per_unit || si?.price_per_unit || 0);
                  // SESUDAH — selalu pakai moving average
                  const harga = Number(si?.price_per_unit || 0);
                  const isOver  = si && Number(item.qty) > maxStok;
                  const nilaiOut = Number(item.qty) * harga;

                  return (
                    <div key={i} data-tour="stock-out-manual-item" className={`rounded-xl p-4 border transition-colors ${
                      isOver ? 'bg-red-500/5 border-red-500/30' : 'bg-slate-700/40 border-slate-600/40'
                    }`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-slate-400 text-xs font-semibold uppercase tracking-wide">
                          Item {i + 1}
                        </span>
                        {outItems.length > 1 && (
                          <button onClick={() => setOutItems(p => p.filter((_, j) => j !== i))}
                            className="text-red-400 hover:text-red-300 text-xs transition-colors">
                            Hapus
                          </button>
                        )}
                      </div>

                      <div className="space-y-3">
                        {/* Pilih bahan */}
                        <div data-tour="stock-out-manual-select">
                          <label className="text-slate-500 text-xs mb-1 block">Pilih Bahan Baku</label>
                          <select
                            value={item.stock_item_id}
                            onChange={e => setOutItems(p => p.map((x, j) =>
                              j === i ? { ...x, stock_item_id: e.target.value, qty: '' } : x
                            ))}
                            className="w-full bg-slate-700 border border-slate-600 text-white text-sm
                              rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50">
                            <option value="">-- Pilih bahan yang tersedia --</option>
                            {summary
                              .filter(s => Number(s.current_stock) > 0)
                              .map(s => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({s.unit}) · Stok: {fmtQty(s.current_stock)}
                                </option>
                              ))
                            }
                          </select>
                        </div>

                        {/* Info stok tersedia */}
                        {si && (
                          <div data-tour="stock-out-stock-price-info" className="grid grid-cols-2 gap-2">
                            <div className="bg-slate-700/60 rounded-lg px-3 py-2 text-xs">
                              <p className="text-slate-500 mb-0.5">Stok Gudang</p>
                              <p className={`font-semibold ${maxStok <= 0 ? 'text-red-400' : 'text-white'}`}>
                                {fmtQty(maxStok)} {si.unit}
                              </p>
                            </div>
                            <div className="bg-slate-700/60 rounded-lg px-3 py-2 text-xs">
                              <p className="text-slate-500 mb-0.5">Harga / {si.unit}</p>
                              <p className="text-white font-semibold">
                                {harga > 0
                                  ? `Rp ${harga.toLocaleString('id-ID')}`
                                  : <span className="text-slate-600">Belum ada</span>
                                }
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Input jumlah */}
                        <div data-tour="stock-out-manual-qty">
                          <label className="text-slate-500 text-xs mb-1 block">
                            Jumlah {si ? `(max ${fmtQty(maxStok)} ${si.unit})` : ''}
                          </label>
                          <input
                            type="number" min="1" max={maxStok || undefined}
                            value={item.qty} placeholder="0"
                            onChange={e => setOutItems(p => p.map((x, j) =>
                              j === i ? { ...x, qty: e.target.value } : x
                            ))}
                            className={`w-full bg-slate-700 border text-white text-sm
                              rounded-xl px-3 py-2.5 outline-none focus:ring-2
                              placeholder:text-slate-600 transition-colors ${
                              isOver
                                ? 'border-red-500/60 focus:ring-red-500/50'
                                : 'border-slate-600 focus:ring-orange-500/50'
                            }`}
                          />
                          {isOver && (
                            <p className="text-red-400 text-xs mt-1 flex items-center gap-1">
                              ⚠ Melebihi stok gudang ({maxStok.toFixed(2)} {si.unit})
                            </p>
                          )}
                        </div>

                        {/* Catatan */}
                        <div data-tour="stock-out-manual-note">
                          <label className="text-slate-500 text-xs mb-1 block">Catatan (opsional)</label>
                          <input
                            type="text" value={item.note || ''} placeholder="keterangan pengeluaran..."
                            onChange={e => setOutItems(p => p.map((x, j) =>
                              j === i ? { ...x, note: e.target.value } : x
                            ))}
                            className="w-full bg-slate-700 border border-slate-600 text-white text-sm
                              rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-orange-500/50
                              placeholder:text-slate-600"
                          />
                        </div>

                        {/* Preview nilai item ini */}
                        {si && Number(item.qty) > 0 && (
                          <div data-tour="stock-out-item-preview" className={`rounded-lg px-3 py-2 flex justify-between text-xs ${
                            isOver ? 'bg-red-500/10 border border-red-500/20' : 'bg-orange-500/10 border border-orange-500/20'
                          }`}>
                            <span className="text-slate-500">
                              {item.qty} × Rp {harga.toLocaleString('id-ID')}
                            </span>
                            <span className={`font-bold ${isOver ? 'text-red-400' : 'text-orange-400'}`}>
                              {isOver ? '⚠ Over stok' : `Rp ${nilaiOut.toLocaleString('id-ID')}`}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              )}

              {/* Tambah bahan */}
              {!hasOutMenuSelection && (
              <button
                data-tour="stock-out-add-item"
                onClick={() => setOutItems(p => [...p, { stock_item_id:'', qty:'', note:'' }])}
                className="w-full py-2.5 rounded-xl border border-dashed border-slate-600
                  text-slate-500 hover:text-slate-300 hover:border-slate-500 text-sm transition-all">
                + Tambah Bahan Lain
              </button>
              )}

              {/* Ringkasan total */}
              <div data-tour="stock-out-total" className="bg-slate-700/50 rounded-xl p-4 border border-slate-600/40 space-y-2">
                {/* Per item */}
                {outItems.filter(it => it.stock_item_id && Number(it.qty) > 0).map((it, i) => {
                  const s    = summary.find(st => st.id == it.stock_item_id);
                  const h    = Number(s?.latest_cost_per_unit || s?.price_per_unit || 0);
                  const over = s && Number(it.qty) > Number(s.current_stock);
                  if (!s) return null;
                  return (
                    <div key={i} className="flex justify-between text-xs">
                      <span className="text-slate-500">{s.name} × {it.qty} {s.unit}</span>
                      <span className={over ? 'text-red-400' : 'text-slate-400'}>
                        {over ? '⚠ Over' : `Rp ${(Number(it.qty) * h).toLocaleString('id-ID')}`}
                      </span>
                    </div>
                  );
                })}

                {/* Garis total */}
                <div className="flex justify-between items-center pt-2 border-t border-slate-600/60">
                  <div>
                    <p className="text-slate-300 text-sm font-semibold">Total Nilai Pengeluaran</p>
                    <p className="text-slate-600 text-xs mt-0.5">
                      {outItems.filter(i => i.stock_item_id && Number(i.qty) > 0).length} item
                    </p>
                  </div>
                  <p className="text-red-400 font-black text-xl">
                    Rp {outItems.reduce((s, it) => {
                      const si   = summary.find(st => st.id == it.stock_item_id);
                      const h    = Number(si?.latest_cost_per_unit || si?.price_per_unit || 0);
                      const over = si && Number(it.qty) > Number(si.current_stock);
                      if (over || !si) return s;
                      return s + (Number(it.qty) * h);
                    }, 0).toLocaleString('id-ID')}
                  </p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div data-tour="stock-out-actions" className="flex gap-3 p-5 pt-0">
              <button
                onClick={() => {
                   // Ganti pesan sukses setelah submit
                    setShowOutForm(false);
                    setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                    setOutUserId('');
                    setOutMenuSelections([createEmptyRecipeSelection()]);
                    // Redirect ke tab pengajuan supaya admin bisa lihat & approve
                    setTab('requests');
                    loadRequests();
                    setSuccessModal({
                      isOpen: true,
                      title: 'Pengeluaran Tercatat',
                      message: 'Pengajuan pengeluaran berhasil dibuat. Silakan approve di tab Pengajuan Kasir.',
                      requestType: 'withdrawal',
                    });
                }}
                className="flex-1 py-3 rounded-xl bg-slate-700 text-slate-300
                  hover:bg-slate-600 text-sm font-semibold transition-colors">
                Batal
              </button>
              <button
                data-tour="stock-out-save-button"
                onClick={async () => {
                  if (!outUserId) return alert('Pilih kasir terlebih dahulu');
                  if (hasOutMenuSelection && (!hasOutRecipeSelection || outRecipeOverStock)) {
                    return alert('Qty menu melebihi stok bahan yang tersedia');
                  }
                  const valid = outItems.length > 0 && outItems.every(i => i.stock_item_id && Number(i.qty) > 0);
                  if (!valid) return alert('Lengkapi semua item (pilih bahan dan isi jumlah)');
                  const overStock = outItems.some(item => {
                    const si = summary.find(s => s.id == item.stock_item_id);
                    return si && Number(item.qty) > Number(si.current_stock);
                  });
                  if (overStock) return alert('Ada item yang melebihi stok gudang');
                  setOutLoading(true);
                  try {
                    await addManualStockOut({
                      user_id: Number(outUserId),
                      items: outItems.map(i => ({
                        stock_item_id: Number(i.stock_item_id),
                        qty:           Number(i.qty),
                        note:          i.note || '',
                      })),
                    });
                     // Ganti pesan sukses setelah submit
                    setShowOutForm(false);
                    setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                    setOutUserId('');
                    // Redirect ke tab pengajuan supaya admin bisa lihat & approve
                    setTab('requests');
                    loadRequests();
                    setSuccessModal({
                      isOpen: true,
                      title: 'Pengeluaran Tercatat',
                      message: 'Pengajuan pengeluaran berhasil dibuat. Silakan approve di tab Pengajuan Kasir.',
                      requestType: 'withdrawal',
                    });
                    loadDaily(); loadSummary(); loadMaster(); loadRequests();
                  } catch(e) {
                    setSuccessModal({
                      isOpen: true,
                      title: 'Terjadi Kesalahan',
                      message: e.response?.data?.message || 'Gagal menyimpan pengeluaran',
                      requestType: 'withdrawal',
                    });
                  } finally { setOutLoading(false); }
                }}
                disabled={
                  outLoading ||
                  !outUserId ||
                  (hasOutMenuSelection && (!hasOutRecipeSelection || outRecipeOverStock)) ||
                  outItems.some(item => {
                    const si = summary.find(s => s.id == item.stock_item_id);
                    return si && Number(item.qty) > Number(si.current_stock);
                  })
                }
                className="flex-1 py-3 rounded-xl bg-red-500 hover:bg-red-400 text-white
                  text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {outLoading ? 'Menyimpan...' : '📤 Simpan Pengeluaran'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MODAL: APPROVE PENGAJUAN ══ */}
      {approveModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-slate-700 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-5 border-b border-slate-700/60">
              <h3 className="text-white font-bold text-base">Proses Pengajuan Stok</h3>
              <div className="flex items-center gap-2 mt-2">
                <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center
                  text-orange-400 text-sm font-bold shrink-0">
                  {approveModal.user_name?.charAt(0)?.toUpperCase()}
                </div>
                <div>
                  <p className="text-white text-sm font-semibold">{approveModal.user_name}</p>
                  <p className="text-slate-500 text-xs">
                    {new Date(approveModal.date).toLocaleDateString('id-ID', {
                      weekday:'long', day:'numeric', month:'long', year:'numeric'
                    })}
                  </p>
                </div>
              </div>
              {approveModal.note && (
                <p className="text-slate-500 text-xs mt-2 italic ml-10">&quot;{approveModal.note}&quot;</p>
              )}
            </div>

            <div className="p-5 space-y-3">
              <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide">
                Detail Barang yang Diajukan
              </p>

              {approveItems.map((item, i) => {
                const stockInfo = summary.find(s => s.id === item.stock_item_id);
                const maxQty = stockInfo ? Number(stockInfo.current_stock) : 0;
                const isOver = Number(item.qty_approved) > maxQty;

                return (
                  <div key={item.id} className={`rounded-xl p-3 border ${
                    isOver ? 'bg-red-500/5 border-red-500/30' : 'bg-slate-700/40 border-slate-600/30'
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white text-sm font-semibold">{item.item_name}</span>
                      <span className="text-slate-500 text-xs bg-slate-700 px-2 py-0.5 rounded-lg">
                        {item.unit}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                      <div className="bg-slate-700/60 rounded-lg px-2 py-2">
                        <p className="text-slate-500 mb-0.5">Diajukan</p>
                        <p className="text-white font-bold">{fmtQty(item.qty_requested)} {item.unit}</p>
                      </div>
                      <div className="bg-slate-700/60 rounded-lg px-2 py-2">
                        <p className="text-slate-500 mb-0.5">Stok Gudang</p>
                        <p className={`font-bold ${maxQty <= 0 ? 'text-red-400' : 'text-green-400'}`}>
                          {fmtQty(maxQty)} {item.unit}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500 mb-1">Qty Disetujui</p>
                        <input
                          type="number" min="0" max={maxQty}
                          value={fmtQty(item.qty_approved) } placeholder="0"
                          onChange={e => setApproveItems(p => p.map((x,j) =>
                            j===i ? { ...x, qty_approved: e.target.value } : x
                          ))}
                          className={`w-full bg-slate-700 border text-white text-sm rounded-lg px-2 py-1.5
                            outline-none focus:ring-2 ${
                            isOver
                              ? 'border-red-500/60 focus:ring-red-500/50'
                              : 'border-slate-600 focus:ring-orange-500/50'
                          }`}
                        />
                      </div>
                    </div>

                    {isOver && (
                      <p className="text-red-400 text-xs">
                        ⚠ Melebihi stok gudang ({fmtQty(maxQty)} {item.unit})
                      </p>
                    )}

                    <div className="flex justify-between text-xs mt-1.5 pt-1.5 border-t border-slate-700/40">
                      <span className="text-slate-500">Harga/sat</span>
                      <span className="text-slate-400">Rp {Number(item.cost_per_unit).toLocaleString('id-ID')}</span>
                      <span className="text-slate-500">Nilai disetujui</span>
                      <span className="text-orange-400 font-semibold">
                        Rp {(Number(item.qty_approved||0) * Number(item.cost_per_unit)).toLocaleString('id-ID')}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Ringkasan total */}
              <div className="bg-slate-700/50 rounded-xl p-4 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Total diajukan</span>
                  <span className="text-slate-300">
                    {approveItems.length} item ·
                    Rp {approveItems.reduce((s,i) =>
                      s + Number(i.qty_requested) * Number(i.cost_per_unit), 0
                    ).toLocaleString('id-ID')}
                  </span>
                </div>
                <div className="flex justify-between items-center pt-1 border-t border-slate-700/40">
                  <span className="text-slate-400 text-sm font-semibold">Total disetujui</span>
                  <span className="text-white font-black text-lg">
                    Rp {approveItems.reduce((s,i) =>
                      s + (Number(i.qty_approved||0) * Number(i.cost_per_unit)), 0
                    ).toLocaleString('id-ID')}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex gap-3 p-5 pt-0">
              <button onClick={() => setApproveModal(null)}
                className="flex-1 py-3 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm font-semibold">
                Batal
              </button>
              <button onClick={() => handleApprove('reject')}
                className="px-5 py-3 rounded-xl bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 text-sm font-semibold transition-colors">
                ✕ Tolak
              </button>
              <button
                onClick={() => {
                  const hasOver = approveItems.some(item => {
                    const si = summary.find(s => s.id === item.stock_item_id);
                    return Number(item.qty_approved) > Number(si?.current_stock || 0);
                  });
                  if (hasOver) return alert('Ada item yang melebihi stok gudang');
                  handleApprove('approve');
                }}
                className="flex-1 py-3 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold">
                ✓ Setujui
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── KASIR VIEW ────────────────────────────────────────────────
function KasirStockPage({ successModal, setSuccessModal }) {
  const { user } = useAuthStore();
  const [tab,      setTab]      = useState('gudang');
  const [mainTab,  setMainTab]  = useState('summary');

  const [summary,   setSummary]  = useState([]);
  const [daily,     setDaily]    = useState([]);
  const [selDate,   setSelDate]  = useState(() => toLocalDateKey());
  const [selDateTo, setSelDateTo]= useState(() => toLocalDateKey());

  const [requests,    setRequests]   = useState([]);
  const [reqStatus,   setReqStatus]  = useState('');
  const [reqDateFrom, setReqDateFrom]= useState(() => toLocalDateKey());
  const [reqDateTo,   setReqDateTo]  = useState(() => toLocalDateKey());

  const [showOutForm, setShowOutForm] = useState(false);
  const [outItems,    setOutItems]    = useState([{ stock_item_id:'', qty:'', note:'' }]);
  const [outLoading,  setOutLoading]  = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [productOptions, setProductOptions] = useState([]);
  const [outMenuSelections, setOutMenuSelections] = useState([createEmptyRecipeSelection()]);
  const [warehouseSearch, setWarehouseSearch] = useState('');
  const [requestSearch, setRequestSearch] = useState('');
  const [summaryTablePage, setSummaryTablePage] = useState(0);
  const [summaryTablePageSize, setSummaryTablePageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [stockOutTablePage, setStockOutTablePage] = useState(0);
  const [stockOutTablePageSize, setStockOutTablePageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);

  const hasOutMenuSelection = hasRecipeProductSelection(outMenuSelections);
  const hasOutRecipeSelection = getRecipeSelectionDetails(productOptions, outMenuSelections).length > 0;
  const outRecipeRows = hasOutRecipeSelection ? buildRecipeRowsForSelections(productOptions, outMenuSelections, summary) : [];
  const outRecipeOverStock = hasRowsOverStock(outRecipeRows);
  const outRecipeSelectionLabel = getRecipeSelectionLabel(productOptions, outMenuSelections);
  const syncOutRecipeSelections = (nextSelections) => {
    setOutMenuSelections(nextSelections);
    if (!hasRecipeProductSelection(nextSelections)) {
      setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
      return;
    }
    setOutItems(buildRecipeOutItemsForSelections(productOptions, nextSelections));
  };

  // Di dalam function KasirStockPage(), tambah setelah state declarations:
  const searchParams = useSearchParams();

  // Ubah loadSummary agar return promise
  const loadSummary = useCallback(() => {
    setSummaryLoading(true);
    return getMainStockSummary()
      .then(r => {
        const data = Array.isArray(r.data) ? r.data : [];
        setSummary(data);
        return data;
      })
      .catch(err => {
        console.error('Summary error:', err.response?.status);
        setSummary([]);
        return [];
      })
      .finally(() => setSummaryLoading(false));
  }, []);

  // Ganti useEffect pertama (yang loadSummary) dengan ini:
  useEffect(() => {
    const fromPos     = searchParams.get('from') === 'pos';
    const ingredients = searchParams.get('ingredients');
    const productName = searchParams.get('product_name');

    if (fromPos && ingredients) {
      // Load summary dulu, baru buka form dengan data yang sudah ada
      loadSummary().then(() => {
        try {
          const parsedIngs = JSON.parse(ingredients);
          setTab('gudang');
          setMainTab('out');
          setShowOutForm(true);
          setOutMenuSelections([createEmptyRecipeSelection()]);
          setOutItems(parsedIngs.map(ing => ({
            stock_item_id: String(ing.stock_item_id),
            qty:           String(getRequestedQtyFromIngredient(ing)),
            note:          `Stok untuk ${productName || 'produk'}`,
          })));
        } catch (_) {}
      });
    } else {
      loadSummary();
    }
  }, [searchParams]);

  useEffect(() => {
    getProducts().then(r => setProductOptions(Array.isArray(r.data) ? r.data : [])).catch(() => setProductOptions([]));
  }, []);

  // Filter daily hanya milik user ini
  // Di KasirStockPage — loadDaily sudah benar kirim user_id
  // const loadDaily = useCallback(() =>
  //   getMainStockDaily({
  //     date_from: selDate,
  //     date_to:   selDateTo || selDate,
  //     user_id:   user?.id,
  //   }).then(r => setDaily(Array.isArray(r.data) ? r.data : [])),
  //   [selDate, selDateTo, user?.id]);

  // Tambah state di KasirStockPage
  const [outTypeFilter, setOutTypeFilter] = useState('all');

  // Update loadDaily kasir
  const loadDaily = useCallback(() => {
    setDailyLoading(true);
    return getMainStockDaily({
      date_from:   selDate,
      date_to:     selDateTo || selDate,
      user_id:     user?.id,
      type_filter: outTypeFilter !== 'all' ? outTypeFilter : undefined,
    })
      .then(r => setDaily(Array.isArray(r.data) ? r.data : []))
      .finally(() => setDailyLoading(false));
  }, [selDate, selDateTo, user?.id, outTypeFilter]);

  useEffect(() => {
    if (tab === 'gudang' && mainTab === 'out') loadDaily();
  }, [outTypeFilter]);

  // Definisi filter — sama untuk admin & kasir
  const OUT_FILTERS = [
    { val: 'all',         label: 'Semua'          },
    { val: 'approved',    label: '✓ Sudah Keluar' },
    { val: 'pending',     label: '⏳ Menunggu'     },
    { val: 'rejected',    label: '✕ Ditolak'       },
    { val: 'transaction', label: '🧾 Transaksi POS'},
    { val: 'manual',      label: '📋 Manual Kasir' },
  ];

  // Warna badge per status
  function TypeBadge({ type, status }) {
    if (type === 'transaction') return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/20">
        🧾 Transaksi
      </span>
    );
    if (type === 'pending_out' && status === 'pending') return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
        📋 Menunggu
      </span>
    );
    if (type === 'pending_out' && status === 'rejected') return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
        📋 Ditolak
      </span>
    );
    return (
      <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-green-500/15 text-green-400 border border-green-500/20">
        📦 Keluar
      </span>
    );
  }

  const loadRequests = useCallback(() => {
    setRequestsLoading(true);
    return getMyStockRequests({
      status:    reqStatus   || undefined,
      date_from: reqDateFrom || undefined,
      date_to:   reqDateTo   || undefined,
    })
      .then(r => setRequests(r.data))
      .finally(() => setRequestsLoading(false));
  }, [reqStatus, reqDateFrom, reqDateTo]);

  // useEffect(() => {
  //   if (tab === 'gudang') {
  //     loadSummary(); // ← tambah ini agar summary fresh setiap masuk tab gudang
  //     loadDaily();
  //   }
  // }, [tab, selDate, selDateTo]);
  useEffect(() => {
    if (tab === 'gudang') {
      // FIX: chain — summary selesai dulu baru daily
      loadSummary().then(() => {
        if (mainTab === 'out') loadDaily();
      });
    }
  }, [tab, selDate, selDateTo]);

  // FIX: tambah useEffect untuk mainTab change
  useEffect(() => {
    if (tab === 'gudang' && mainTab === 'out') {
      loadDaily();
    }
  }, [mainTab]);
  useEffect(() => {
    if (tab === 'requests') loadRequests();
  }, [tab, loadRequests]);

  // Tampilkan hanya pengeluaran yang diapprove dan milik user ini
  const outData = daily;
  const filteredSummary = summary.filter((row) => rowMatchesSearch(row, warehouseSearch, ['name', 'unit']));
  const summaryTablePageCount = getTablePageCount(filteredSummary.length, summaryTablePageSize);
  const visibleSummaryRows = getTableRows(filteredSummary, summaryTablePage, summaryTablePageSize);
  const searchedOutData = outData.filter((row) => rowMatchesSearch(row, warehouseSearch, [
    'item_name', 'unit', 'note', 'branch_name', 'stock_owner_name', 'target_user_name', 'created_by_name', 'admin_name', 'request_status', 'type',
  ]));
  const stockOutTablePageCount = getTablePageCount(searchedOutData.length, stockOutTablePageSize);
  const visibleStockOutRows = getTableRows(searchedOutData, stockOutTablePage, stockOutTablePageSize);
  const filteredRequests = requests.filter((req) => {
    const requestFieldsMatch = rowMatchesSearch(req, requestSearch, [
      'status', 'note', 'approved_by_name',
    ]);
    const itemMatch = (req.items || []).some((item) => rowMatchesSearch(item, requestSearch, [
      'item_name', 'unit', 'note',
    ]));
    return requestFieldsMatch || itemMatch;
  });
  const warehouseInitialLoading = (mainTab === 'summary' && summaryLoading && summary.length === 0)
    || (mainTab === 'out' && dailyLoading && daily.length === 0);
  const requestsInitialLoading = requestsLoading && requests.length === 0;
  const stockRefreshing = Boolean(
    (summaryLoading && summary.length > 0)
    || (dailyLoading && daily.length > 0)
    || (requestsLoading && requests.length > 0)
  );

  useEffect(() => {
    if (summaryTablePage >= summaryTablePageCount) setSummaryTablePage(0);
  }, [summaryTablePage, summaryTablePageCount]);

  useEffect(() => {
    if (stockOutTablePage >= stockOutTablePageCount) setStockOutTablePage(0);
  }, [stockOutTablePage, stockOutTablePageCount]);

  useEffect(() => {
    setSummaryTablePage(0);
    setStockOutTablePage(0);
  }, [warehouseSearch, mainTab, selDate, selDateTo, outTypeFilter]);

  return (
    <>
      <div data-tour="stock-tabs" className="mb-5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2 bg-slate-800/50 rounded-2xl p-1.5 w-fit">
        <TabBtn data-tour-action="stock-tab-warehouse" active={tab==='gudang'}   onClick={() => setTab('gudang')}>   🏪 Stok Gudang</TabBtn>
        <TabBtn data-tour-action="stock-tab-requests" active={tab==='requests'} onClick={() => setTab('requests')}> 📋 Pengajuan Saya</TabBtn>
        <TabBtn data-tour-action="stock-tab-issues" active={tab==='issues'} onClick={() => setTab('issues')}> ⚠️ Sisa Stok</TabBtn>
        </div>
        {stockRefreshing && (
          <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-200">
            Sinkronisasi stok...
          </span>
        )}
      </div>

      {tab === 'gudang' && (
        warehouseInitialLoading ? (
          <StockWarehouseSkeleton mode={mainTab} />
        ) : (
        <div data-tour="stock-warehouse" className="space-y-4">
          <div data-tour="stock-warehouse-tabs" className="flex flex-wrap items-center gap-2">
            <SubTab data-tour-action="stock-subtab-summary" active={mainTab==='summary'} onClick={() => setMainTab('summary')}>📊 Saldo Stok</SubTab>
            <SubTab data-tour-action="stock-subtab-out" active={mainTab==='out'}     onClick={() => setMainTab('out')}>📤 Pengeluaran</SubTab>
            <input
              value={warehouseSearch}
              onChange={(e) => setWarehouseSearch(e.target.value)}
              placeholder="Cari stok gudang..."
              className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-white outline-none placeholder:text-slate-500 focus:border-orange-500/60 sm:w-56"
            />
          </div>

          {/* ── Saldo Stok ── */}
          {mainTab === 'summary' && (
            <div data-tour="stock-summary" className="space-y-3">
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3 flex gap-2.5">
                <span className="text-blue-400 shrink-0">ℹ</span>
                <p className="text-slate-500 text-xs">
                  Saldo stok gudang keseluruhan. Semua Stok dilakukan proses approve oleh admin.
                </p>
              </div>
              <div data-tour="stock-summary-table" className="bg-slate-800/80 rounded-2xl border border-slate-700/60 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/60 bg-slate-800/30">
                        {['Bahan Baku','Satuan','Total Masuk','Total Keluar','Saldo Stok','Status'].map(h =>
                          <th key={h} className={thC}>{h}</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSummary.length === 0
                        ? <tr><td colSpan={6}><EmptyState title="Belum ada data stok" /></td></tr>
                        : visibleSummaryRows.map((row, i) => {
                            const cur = Number(row.current_stock);
                            return (
                              <tr key={row.id} className={trC(getTableOffset(summaryTablePage, summaryTablePageSize) + i)}>
                                <td className={`${tdC} text-white font-semibold`}>{row.name}</td>
                                <td className={`${tdC} text-slate-400`}>{row.unit}</td>
                                <td className={tdC}>
                                  <span className="text-blue-400 font-semibold">{fmtQty(row.total_in)}</span>
                                  <span className="text-slate-600 text-xs ml-1.5">(Rp {Number(row.total_cost_in).toLocaleString('id-ID')})</span>
                                </td>
                                <td className={tdC}>
                                  <span className="text-red-400 font-semibold">{fmtQty(row.total_out)}</span>
                                  <span className="text-slate-600 text-xs ml-1.5">(Rp {Number(row.total_cost_out).toLocaleString('id-ID')})</span>
                                </td>
                                <td className={tdC}>
                                  <span className={`font-bold ${cur===0?'text-red-400':cur<=row.min_stock?'text-yellow-400':'text-white'}`}>
                                    {fmtQty(cur)} {row.unit}
                                  </span>
                                </td>
                                <td className={tdC}>
                                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                                    cur===0?'bg-red-500/15 text-red-400':
                                    cur<=row.min_stock?'bg-yellow-500/15 text-yellow-400':
                                    'bg-green-500/15 text-green-400'
                                  }`}>
                                    {cur===0?'Habis':cur<=row.min_stock?'Menipis':'Aman'}
                                  </span>
                                </td>
                              </tr>
                            );
                          })
                      }
                    </tbody>
                  </table>
                </div>
                <TablePagination
                  totalRows={filteredSummary.length}
                  page={summaryTablePage}
                  pageSize={summaryTablePageSize}
                  onPageChange={setSummaryTablePage}
                  onPageSizeChange={(size) => {
                    setSummaryTablePageSize(size);
                    setSummaryTablePage(0);
                  }}
                  label="saldo"
                />
              </div>
            </div>
          )}

          {/* ── Pengeluaran ── */}
          {mainTab === 'out' && (
            <div data-tour="stock-out" className="space-y-3">
              <div data-tour="stock-out-filters" className="flex justify-end">
                <div className="w-full max-w-sm lg:ml-auto">
                  <DateRangePicker
                    label="Range pengeluaran"
                    value={{ start: selDate, end: selDateTo || selDate }}
                    onChange={({ start, end }) => {
                      setSelDate(start);
                      setSelDateTo(end || start);
                    }}
                    helperText="Klik tanggal awal pengeluaran, lalu tanggal akhir"
                  />
                </div>
              </div>

              {/* Filter pills kasir — tanpa 'manual' karena kasir sudah filter by user sendiri */}
              <div data-tour="stock-out-pills" className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1.5 items-center">
                  {[
                    { val: 'all',         label: 'Semua'           },
                    { val: 'approved',    label: '✓ Sudah Keluar'  },
                    { val: 'pending',     label: '⏳ Menunggu'      },
                    { val: 'rejected',    label: '✕ Ditolak'        },
                    { val: 'transaction', label: '🧾 Transaksi POS' },
                  ].map(f => (
                    <button key={f.val}
                      onClick={() => setOutTypeFilter(f.val)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                        outTypeFilter === f.val
                          ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                          : 'bg-slate-700/60 text-slate-400 border border-slate-600/60 hover:text-white hover:border-slate-500'
                      }`}>
                      {f.label}
                    </button>
                  ))}
                  <span className="text-slate-600 text-xs ml-1">{searchedOutData.length} data</span>
                </div>
                <button data-tour-action="stock-open-out-modal" onClick={() => {
                  setOutMenuSelections([createEmptyRecipeSelection()]);
                  setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                  setShowOutForm(true);
                }}
                  className="px-4 py-2 rounded-xl text-xs font-semibold
                    bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-all">
                  + Catat Pengeluaran
                </button>
              </div>

              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-3 flex gap-2.5">
                <span className="text-yellow-400 shrink-0">ℹ</span>
                <p className="text-slate-500 text-xs">
                  Pengeluaran atas nama <span className="text-white font-medium">{user?.name}</span> — termasuk dari transaksi POS dan pengajuan manual.
                </p>
              </div>

              <div data-tour="stock-out-table" className="bg-slate-800/80 rounded-2xl border border-slate-700/60 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/60 bg-slate-800/30">
                        {['Tanggal','Bahan Baku','Jumlah','Harga/Sat','Total Nilai','Status Sumber','Sumber Cabang','Sumber Stok','Pengaju','Status','Catatan'].map(h =>
                          <th key={h} className={thC}>{h}</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {searchedOutData.length === 0
                        ? <tr><td colSpan={11}><EmptyState title="Tidak ada data pengeluaran pada periode ini" /></td></tr>
                        : visibleStockOutRows.map((row, i) => {
                          const isPending  = row.type === 'pending_out' && row.request_status === 'pending';
                          const isRejected = row.type === 'pending_out' && row.request_status === 'rejected';
                          const isTx       = row.type === 'transaction';
                          const isApproved = !isPending && !isRejected;

                          return (
                            <tr key={`${row.id}-${i}`} className={trC(getTableOffset(stockOutTablePage, stockOutTablePageSize) + i)}>
                              <td className={`${tdC} text-slate-400 text-xs whitespace-nowrap`}>
                                {new Date(row.created_at).toLocaleDateString('id-ID', {
                                  day:'numeric', month:'short', year:'numeric'
                                })}
                              </td>
                              <td className={`${tdC} text-white font-medium`}>{row.item_name}</td>
                              <td className={`${tdC} font-semibold ${isApproved ? 'text-red-400' : 'text-slate-400'}`}>
                                {fmtQty(row.qty)} {row.unit}
                              </td>
                              <td className={`${tdC} text-slate-300`}>
                                Rp {Number(row.cost_per_unit).toLocaleString('id-ID')}
                              </td>
                              <td className={`${tdC} font-bold ${isApproved ? 'text-red-400' : 'text-slate-500'}`}>
                                Rp {Number(row.total_cost).toLocaleString('id-ID')}
                              </td>
                              <td className={tdC}>
                                <TypeBadge type={row.type} status={row.request_status} />
                              </td>
                              <td className={`${tdC} text-slate-300 text-xs`}>
                                {row.branch_name || 'Cabang aktif'}
                              </td>
                              <td className={`${tdC} text-slate-300 text-xs`}>
                                {row.stock_owner_name || row.target_user_name || row.created_by_name || '—'}
                              </td>
                              {/* ✅ SESUDAH */}
<td className={`${tdC} text-slate-400 text-xs`}>
  {row.admin_name ? (
    // Admin yang pakai stok kasir ini
    <span className="text-blue-400/80 font-semibold">
      {row.admin_name}
    </span>
  ) : (
    // Kasir itu sendiri yang transaksi
    <span className="text-slate-300">
      {row.created_by_name || '—'}
    </span>
  )}
</td>
                              <td className={tdC}>
                                {isTx && (
                                  <span className="text-xs px-2 py-1 rounded-full font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/20">
                                    ✓ Terjual
                                  </span>
                                )}
                                {!isTx && isApproved && (
                                  <span className="text-xs px-2 py-1 rounded-full font-semibold bg-green-500/15 text-green-400 border border-green-500/20">
                                    ✓ Disetujui
                                  </span>
                                )}
                                {isPending && (
                                  <span className="text-xs px-2 py-1 rounded-full font-semibold bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">
                                    ⏳ Menunggu
                                  </span>
                                )}
                                {isRejected && (
                                  <span className="text-xs px-2 py-1 rounded-full font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
                                    ✕ Ditolak
                                  </span>
                                )}
                              </td>
                              <td className={`${tdC} text-slate-500 text-xs`}>{row.note || '—'}</td>
                            </tr>
                          );
                        })
                      }
                    </tbody>
                  </table>
                </div>
                <TablePagination
                  totalRows={searchedOutData.length}
                  page={stockOutTablePage}
                  pageSize={stockOutTablePageSize}
                  onPageChange={setStockOutTablePage}
                  onPageSizeChange={(size) => {
                    setStockOutTablePageSize(size);
                    setStockOutTablePage(0);
                  }}
                  label="pengeluaran"
                />
              </div>
            </div>
          )}
        </div>
      ))}

      {/* ── PENGAJUAN SAYA ── */}
      {tab === 'requests' && (
        requestsInitialLoading ? (
          <StockRequestSkeleton />
        ) : (
        <div data-tour="stock-requests" className="space-y-4">
          <div data-tour="stock-request-filters" className="space-y-3">
            <div className="flex justify-end">
              <div className="w-full max-w-sm lg:ml-auto">
              <DateRangePicker
                label="Range pengajuan"
                value={{ start: reqDateFrom, end: reqDateTo }}
                onChange={({ start, end }) => {
                  setReqDateFrom(start);
                  setReqDateTo(end || start);
                }}
                helperText="Klik tanggal awal pengajuan, lalu tanggal akhir"
              />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {STOCK_REQUEST_FILTERS.map(({ val, label }) => (
                  <button key={val || 'all'} onClick={() => setReqStatus(val)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                      reqStatus === val
                        ? 'bg-orange-500 text-white'
                        : 'bg-slate-800 text-slate-400 border border-slate-700 hover:text-white'
                    }`}>
                    {label}
                  </button>
                ))}
                <span className="text-slate-600 text-xs">{filteredRequests.length} pengajuan</span>
              </div>
              <input
                value={requestSearch}
                onChange={(e) => setRequestSearch(e.target.value)}
                placeholder="Cari pengajuan..."
                className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-semibold text-white outline-none placeholder:text-slate-500 focus:border-orange-500/60 sm:w-64"
              />
            </div>
          </div>

          {filteredRequests.length === 0
            ? <div data-tour="stock-request-list" className="bg-slate-800/60 rounded-2xl border border-slate-700/40 py-12">
                <EmptyState icon="📋" title="Tidak ada pengajuan" sub="Belum ada pengajuan pengeluaran" />
              </div>
            : filteredRequests.map(req => (
              <div key={req.id} data-tour="stock-request-list" className={`bg-slate-800/80 rounded-2xl border overflow-hidden ${
                req.status==='approved' ? 'border-green-500/30' :
                req.status==='rejected' ? 'border-red-500/30' : 'border-slate-700/60'
              }`}>
                <div className="flex flex-wrap items-start justify-between gap-3 p-4 border-b border-slate-700/40">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-white font-bold text-sm">
                        {new Date(req.date).toLocaleDateString('id-ID', {
                          weekday:'long', day:'numeric', month:'long', year:'numeric'
                        })}
                      </p>
                      <StatusBadge status={req.status} />
                    </div>
                    {req.note && <p className="text-slate-500 text-xs mt-0.5 italic">&quot;{req.note}&quot;</p>}
                    {req.approved_by_name && (
                      <p className="text-slate-600 text-xs mt-0.5">
                        Diproses: <span className="text-slate-400">{req.approved_by_name}</span>
                        {req.approved_at && ` · ${new Date(req.approved_at).toLocaleString('id-ID')}`}
                      </p>
                    )}
                  </div>
                  {req.status === 'rejected' && (
                    <button
                      onClick={async () => {
                        const confirmed = await showConfirm('Ajukan ulang pengajuan ini?', {
                          title: 'Ajukan Ulang Stok',
                          confirmText: 'Ajukan Ulang',
                          tone: 'warning',
                        });
                        if (!confirmed) return;
                        try {
                          await resubmitStockRequest(req.id);
                          loadRequests();
                        } catch(e) { alert(e.response?.data?.message || 'Gagal mengajukan ulang'); }
                      }}
                      className="px-4 py-2 rounded-xl text-xs font-semibold
                        bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-all">
                      🔄 Ajukan Ulang
                    </button>
                  )}
                </div>

                {req.items?.length > 0 && (
                  <div className="overflow-x-auto px-4 py-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-700/40">
                          {['Bahan','Diajukan','Disetujui','Harga/Sat','Nilai Diajukan','Nilai Disetujui'].map(h => (
                            <th key={h} className="text-left text-slate-600 py-1.5 pr-4 font-semibold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {req.items.map(item => (
                          <tr key={item.id} className="border-b border-slate-700/20">
                            <td className="py-1.5 pr-4 text-slate-300 font-medium">
                              {item.item_name} <span className="text-slate-600">({item.unit})</span>
                            </td>
                            <td className="py-1.5 pr-4 text-slate-400">{Number(item.qty_requested).toFixed(2)}</td>
                            <td className="py-1.5 pr-4">
                              {item.qty_approved != null
                                ? <span className="text-green-400 font-semibold">{Number(item.qty_approved).toFixed(2)}</span>
                                : <span className="text-slate-700">—</span>}
                            </td>
                            <td className="py-1.5 pr-4 text-slate-400">Rp {Number(item.cost_per_unit).toLocaleString('id-ID')}</td>
                            <td className="py-1.5 text-orange-400">
                              Rp {(Number(item.qty_requested) * Number(item.cost_per_unit)).toLocaleString('id-ID')}
                            </td>
                            <td className="py-1.5">
                              {item.qty_approved != null
                                ? <span className="text-green-400 font-semibold">
                                    Rp {(Number(item.qty_approved) * Number(item.cost_per_unit)).toLocaleString('id-ID')}
                                  </span>
                                : <span className="text-slate-700">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={4} className="pt-2 text-slate-600 font-semibold">Total</td>
                          <td className="pt-2 text-orange-400 font-bold">
                            Rp {req.items.reduce((s, i) =>
                              s + Number(i.qty_requested) * Number(i.cost_per_unit), 0
                            ).toLocaleString('id-ID')}
                          </td>
                          <td className="pt-2 text-green-400 font-bold">
                            Rp {req.items.reduce((s, i) =>
                              s + (Number(i.qty_approved || 0) * Number(i.cost_per_unit)), 0
                            ).toLocaleString('id-ID')}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            ))
          }
        </div>
      ))}

      {tab === 'issues' && <StockIssuesTab />}

      {/* ══ MODAL: CATAT PENGELUARAN (KASIR) ══ */}
      {showOutForm && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div data-tour="stock-out-modal" className="bg-slate-800 rounded-2xl border border-slate-700 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <button
              type="button"
              data-tour-action="stock-close-out-modal"
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => {
                setShowOutForm(false);
                setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                setOutMenuSelections([createEmptyRecipeSelection()]);
              }}
            />
            <div className="flex items-center justify-between p-5 border-b border-slate-700/60">
              <div>
                <h3 className="text-white font-bold">📤 Ajukan Stok Cabang</h3>
                <p className="text-slate-500 text-xs mt-0.5">Bahan resep otomatis terpilih · Bisa diajukan meski stok cabang 0</p>
              </div>
              <button onClick={() => {
                setShowOutForm(false);
                setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                setOutMenuSelections([createEmptyRecipeSelection()]);
              }}
                className="text-slate-500 hover:text-white p-2 rounded-xl hover:bg-slate-700 transition-colors">✕</button>
            </div>

            <div className="p-5 space-y-4">
              <div data-tour="stock-out-user-info" className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 flex items-center gap-2.5">
                <span className="text-blue-400 shrink-0">ℹ</span>
                <p className="text-blue-400/80 text-xs">
                  Pengajuan akan dibuat atas nama <span className="font-semibold text-blue-400">{user?.name}</span> · Menunggu persetujuan admin
                </p>
              </div>

              <RecipeMenuPicker
                products={productOptions}
                stockRows={summary}
                selections={outMenuSelections}
                title="Ajukan stok dari menu"
                onSelectionsChange={syncOutRecipeSelections}
              />

              {hasOutMenuSelection ? (
                <ReadOnlyRecipeSummary rows={outRecipeRows} title={`Ringkasan bahan untuk ${outRecipeSelectionLabel || 'menu terpilih'}`} />
              ) : (
              <div data-tour="stock-out-manual-list" className="space-y-3">
                {outItems.map((item, i) => {
                  const si       = summary.find(s => s.id == item.stock_item_id);
                  const maxStok  = si ? Number(si.current_stock) : 0;
                  const harga    = Number(si?.price_per_unit || 0);
                  const isOver   = false;
                  const nilaiOut = Number(item.qty) * harga;

                  return (
                    <div key={i} data-tour="stock-out-manual-item" className={`rounded-xl p-4 border transition-colors ${
                      isOver ? 'bg-red-500/5 border-red-500/30' : 'bg-slate-700/40 border-slate-600/40'
                    }`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-slate-400 text-xs font-semibold uppercase tracking-wide">Item {i + 1}</span>
                        {outItems.length > 1 && (
                          <button onClick={() => setOutItems(p => p.filter((_, j) => j !== i))}
                            className="text-red-400 hover:text-red-300 text-xs">Hapus</button>
                        )}
                      </div>
                      <div className="space-y-3">
                        <div data-tour="stock-out-manual-select">
                          <label className="text-slate-500 text-xs mb-1 block">Pilih Bahan Baku</label>
                          <select value={item.stock_item_id}
                            onChange={e => setOutItems(p => p.map((x, j) =>
                              j === i ? { ...x, stock_item_id: e.target.value, qty: '' } : x
                            ))}
                            className="w-full bg-slate-700 border border-slate-600 text-white text-sm
                              rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-orange-500/50">
                            <option value="">-- Pilih bahan baku --</option>
                            {summary.map(s => (
                              <option key={s.id} value={s.id}>
                                {s.name} ({s.unit}) · Stok: {fmtQty(s.current_stock)}
                              </option>
                            ))}
                          </select>
                        </div>

                        {si && (
                          <div data-tour="stock-out-stock-price-info" className="grid grid-cols-2 gap-2">
                            <div className="bg-slate-700/60 rounded-lg px-3 py-2 text-xs">
                              <p className="text-slate-500 mb-0.5">Stok Gudang</p>
                              <p className={`font-semibold ${maxStok <= 0 ? 'text-red-400' : 'text-white'}`}>
                                {fmtQty(maxStok)} {si.unit}
                              </p>
                            </div>
                            <div className="bg-slate-700/60 rounded-lg px-3 py-2 text-xs">
                              <p className="text-slate-500 mb-0.5">Harga / {si.unit}</p>
                              <p className="text-white font-semibold">
                                {harga > 0 ? `Rp ${harga.toLocaleString('id-ID')}` : <span className="text-slate-600">Belum ada</span>}
                              </p>
                            </div>
                          </div>
                        )}

                        <div data-tour="stock-out-manual-qty">
                          <label className="text-slate-500 text-xs mb-1 block">
                            Jumlah yang diajukan {si ? `(${si.unit})` : ''}
                          </label>
                          <input type="number" min="1"
                            value={item.qty} placeholder="0"
                            onChange={e => setOutItems(p => p.map((x, j) =>
                              j === i ? { ...x, qty: e.target.value } : x
                            ))}
                            className={`w-full bg-slate-700 border text-white text-sm rounded-xl px-3 py-2.5
                              outline-none focus:ring-2 placeholder:text-slate-600 transition-colors ${
                              isOver ? 'border-red-500/60 focus:ring-red-500/50' : 'border-slate-600 focus:ring-orange-500/50'
                            }`}
                          />
                          {isOver && (
                            <p className="text-red-400 text-xs mt-1">⚠ Melebihi stok gudang ({fmtQty(maxStok)} {si.unit})</p>
                          )}
                        </div>

                        <div data-tour="stock-out-manual-note">
                          <label className="text-slate-500 text-xs mb-1 block">Catatan (opsional)</label>
                          <input type="text" value={item.note || ''} placeholder="keterangan pengeluaran..."
                            onChange={e => setOutItems(p => p.map((x, j) =>
                              j === i ? { ...x, note: e.target.value } : x
                            ))}
                            className="w-full bg-slate-700 border border-slate-600 text-white text-sm
                              rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-orange-500/50 placeholder:text-slate-600"
                          />
                        </div>

                        {si && Number(item.qty) > 0 && (
                          <div data-tour="stock-out-item-preview" className={`rounded-lg px-3 py-2 flex justify-between text-xs ${
                            isOver ? 'bg-red-500/10 border border-red-500/20' : 'bg-orange-500/10 border border-orange-500/20'
                          }`}>
                            <span className="text-slate-500">{item.qty} × Rp {harga.toLocaleString('id-ID')}</span>
                            <span className={`font-bold ${isOver ? 'text-red-400' : 'text-orange-400'}`}>
                              {isOver ? '⚠ Over stok' : `Rp ${nilaiOut.toLocaleString('id-ID')}`}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              )}

              {!hasOutMenuSelection && (
              <button data-tour="stock-out-add-item" onClick={() => setOutItems(p => [...p, { stock_item_id:'', qty:'', note:'' }])}
                className="w-full py-2.5 rounded-xl border border-dashed border-slate-600
                  text-slate-500 hover:text-slate-300 hover:border-slate-500 text-sm transition-all">
                + Tambah Bahan Lain
              </button>
              )}

              <div data-tour="stock-out-total" className="bg-slate-700/50 rounded-xl p-4 border border-slate-600/40 space-y-2">
                {outItems.filter(it => it.stock_item_id && Number(it.qty) > 0).map((it, i) => {
                  const s    = summary.find(st => st.id == it.stock_item_id);
                  const h    = Number(s?.price_per_unit || 0);
                  const over = s && Number(it.qty) > Number(s.current_stock);
                  if (!s) return null;
                  return (
                    <div key={i} className="flex justify-between text-xs">
                      <span className="text-slate-500">{s.name} × {it.qty} {s.unit}</span>
                      <span className={over ? 'text-red-400' : 'text-slate-400'}>
                        {over ? '⚠ Over' : `Rp ${(Number(it.qty) * h).toLocaleString('id-ID')}`}
                      </span>
                    </div>
                  );
                })}
                <div className="flex justify-between items-center pt-2 border-t border-slate-600/60">
                  <div>
                    <p className="text-slate-300 text-sm font-semibold">Total Nilai Pengajuan</p>
                    <p className="text-slate-600 text-xs mt-0.5">
                      {outItems.filter(i => i.stock_item_id && Number(i.qty) > 0).length} item
                    </p>
                  </div>
                  <p className="text-red-400 font-black text-xl">
                    Rp {outItems.reduce((s, it) => {
                      const si   = summary.find(st => st.id == it.stock_item_id);
                      const h    = Number(si?.price_per_unit || 0);
                      const over = si && Number(it.qty) > Number(si.current_stock);
                      if (!si || over) return s;
                      return s + (Number(it.qty) * h);
                    }, 0).toLocaleString('id-ID')}
                  </p>
                </div>
              </div>
            </div>

            <div data-tour="stock-out-actions" className="flex gap-3 p-5 pt-0">
              <button onClick={() => {
                setShowOutForm(false);
                setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                setOutMenuSelections([createEmptyRecipeSelection()]);
              }}
                className="flex-1 py-3 rounded-xl bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm font-semibold">
                Batal
              </button>
              <button
                onClick={async () => {
                  if (hasOutMenuSelection && (!hasOutRecipeSelection || outRecipeOverStock)) {
                    return alert('Qty menu melebihi stok bahan yang tersedia');
                  }
                  const valid = outItems.length > 0 && outItems.every(i => i.stock_item_id && Number(i.qty) > 0);
                  if (!valid) return alert('Lengkapi semua item');
                  const overStock = outItems.some(item => {
                    const si = summary.find(s => s.id == item.stock_item_id);
                    return si && Number(item.qty) > Number(si.current_stock);
                  });
                  if (overStock) return alert('Ada item yang melebihi stok gudang');
                  setOutLoading(true);
                  try {
                    await submitStockRequest({
                      note: mergeStockRequestNotes(outItems),
                      items: outItems.map(i => ({
                        stock_item_id: Number(i.stock_item_id),
                        qty:           Number(i.qty),
                      })),
                    });
                    setShowOutForm(false);
                    setOutItems([{ stock_item_id:'', qty:'', note:'' }]);
                    setOutMenuSelections([createEmptyRecipeSelection()]);
                    setTab('requests');
                    loadRequests();
                    setSuccessModal({
                      isOpen: true,
                      title: 'Permintaan Stok Dikirim',
                      message: 'Pengajuan pengeluaran berhasil dibuat. Menunggu persetujuan admin.',
                      requestType: 'request',
                    });
                  } catch(e) {
                    setSuccessModal({
                      isOpen: true,
                      title: 'Terjadi Kesalahan',
                      message: e.response?.data?.message || 'Gagal menyimpan pengeluaran',
                      requestType: 'request',
                    });
                  } finally { setOutLoading(false); }
                }}
                disabled={
                  outLoading ||
                  (hasOutMenuSelection && (!hasOutRecipeSelection || outRecipeOverStock)) ||
                  outItems.some(item => {
                    const si = summary.find(s => s.id == item.stock_item_id);
                    return si && Number(item.qty) > Number(si.current_stock);
                  })
                }
                className="flex-1 py-3 rounded-xl bg-red-500 hover:bg-red-400 text-white
                  text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {outLoading ? 'Menyimpan...' : '📤 Kirim Pengajuan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── MAIN EXPORT ───────────────────────────────────────────────
export default function StockPage() {
  const { user } = useAuthStore();
  const isAdmin  = user?.role === 'admin';

  // ✅ Success Modal State — MOVED TO PARENT LEVEL
  const [successModal, setSuccessModal] = useState({
    isOpen: false,
    title: 'Sukses',
    message: 'Operasi berhasil dilakukan',
    requestType: 'withdrawal',
  });

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto pb-8 space-y-5">
        <div data-tour="stock-header">
          <h1 className="text-white text-xl sm:text-2xl font-black tracking-tight">
            {isAdmin ? 'Manajemen Stok' : 'Stok Saya'}
          </h1>
          <p className="text-slate-500 text-xs sm:text-sm mt-0.5">
            {isAdmin
              ? 'Master bahan baku · Stok gudang · Pengajuan kasir'
              : 'Lihat pemasukan · Buat pengajuan stok · Pantau status'
            }
          </p>
        </div>

        {isAdmin ? <AdminStockPage successModal={successModal} setSuccessModal={setSuccessModal} /> : <KasirStockPage successModal={successModal} setSuccessModal={setSuccessModal} />}
      </div>

      {/* Success Modal */}
      <SuccessModal
        isOpen={successModal.isOpen}
        onClose={() => setSuccessModal({ ...successModal, isOpen: false })}
        title={successModal.title}
        message={successModal.message}
        requestType={successModal.requestType}
      />
    </AdminLayout>
  );
}



