'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import {
  createStockIssue,
  getMainStockSummary,
  getStockIssueSummary,
  getStockIssues,
  rejectStockIssue,
  resolveStockIssue,
} from '@/lib/api';
import { showConfirm, showPrompt } from '@/lib/modalDialog';

const reasonMeta = {
  expired: { label: 'Expired', icon: '⏰', className: 'border-amber-500/25 bg-amber-500/10 text-amber-200' },
  damaged: { label: 'Rusak', icon: '⚠️', className: 'border-red-500/25 bg-red-500/10 text-red-200' },
  lost: { label: 'Hilang', icon: '🧾', className: 'border-violet-500/25 bg-violet-500/10 text-violet-200' },
  other: { label: 'Lainnya', icon: '📌', className: 'border-slate-500/25 bg-slate-500/10 text-slate-200' },
};

const statusMeta = {
  reported: { label: 'Menunggu', className: 'border-yellow-500/25 bg-yellow-500/10 text-yellow-200' },
  resolved: { label: 'Selesai', className: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200' },
  rejected: { label: 'Ditolak', className: 'border-red-500/25 bg-red-500/10 text-red-200' },
};

const emptyForm = {
  stock_item_id: '',
  qty: '',
  unit: '',
  reason: 'expired',
  description: '',
  comments: '',
};

const formatDateTime = (value) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtQty = (value) => {
  const qty = Number(value || 0);
  return qty % 1 === 0 ? String(Math.round(qty)) : qty.toFixed(2);
};

function IssueBadge({ type, value }) {
  const meta = type === 'reason' ? reasonMeta[value] : statusMeta[value];
  if (!meta) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-black ${meta.className}`}>
      {type === 'reason' && <span>{meta.icon}</span>}
      {meta.label}
    </span>
  );
}

function SummaryCard({ title, value, sub, className }) {
  return (
    <div className={`rounded-2xl border p-4 ${className}`}>
      <p className="text-xs font-black uppercase tracking-[0.16em] opacity-70">{title}</p>
      <strong className="mt-2 block text-3xl font-black">{Number(value || 0).toLocaleString('id-ID')}</strong>
      {sub && <p className="mt-1 text-xs opacity-70">{sub}</p>}
    </div>
  );
}

export default function StockIssuesTab() {
  const { user, selectedBranchId } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  const [summary, setSummary] = useState(null);
  const [issues, setIssues] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  const [mode, setMode] = useState('reported');
  const [reason, setReason] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const selectedStockItem = useMemo(
    () => stockItems.find((item) => String(item.id) === String(form.stock_item_id)),
    [stockItems, form.stock_item_id]
  );

  const loadStockItems = useCallback(async () => {
    const branchId = selectedBranchId || user?.default_branch_id || user?.branch_id;
    const res = await getMainStockSummary(branchId ? { branch_id: branchId } : undefined);
    const rows = Array.isArray(res.data) ? res.data : [];
    setStockItems(rows.map((item) => ({
      ...item,
      stock: Number(item.current_stock ?? item.stock ?? 0),
      price_per_unit: Number(item.latest_cost_per_unit ?? item.price_per_unit ?? 0),
    })));
  }, [selectedBranchId, user?.branch_id, user?.default_branch_id]);

  const loadSummary = useCallback(async () => {
    const res = await getStockIssueSummary();
    setSummary(res.data || null);
  }, []);

  const loadIssues = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 10 };
      if (mode === 'reported') params.status = 'reported';
      if (mode === 'history') params.status = 'resolved,rejected';
      if (reason) params.reason = reason;
      const res = await getStockIssues(params);
      setIssues(res.data?.data || res.data?.items || []);
      setTotalPages(res.data?.pagination?.pages || res.data?.totalPages || 1);
    } finally {
      setLoading(false);
    }
  }, [mode, page, reason]);

  const refresh = useCallback(async () => {
    await Promise.all([loadSummary(), loadIssues()]);
  }, [loadSummary, loadIssues]);

  useEffect(() => {
    loadStockItems().catch(() => {});
    loadSummary().catch(() => {});
  }, [loadStockItems, loadSummary]);

  useEffect(() => {
    loadIssues().catch(() => setLoading(false));
  }, [loadIssues]);

  useEffect(() => {
    if (!selectedStockItem) return;
    setForm((prev) => ({ ...prev, unit: selectedStockItem.unit || prev.unit }));
  }, [selectedStockItem]);

  const submitIssue = async (event) => {
    event.preventDefault();
    const qty = Number(form.qty || 0);
    if (!form.stock_item_id || qty <= 0 || !form.unit || !form.reason) {
      await showConfirm('Lengkapi bahan, jumlah, satuan, dan alasan sisa stok terlebih dahulu.', {
        title: 'Form belum lengkap',
        confirmText: 'Mengerti',
        cancelText: '',
        tone: 'warning',
      });
      return;
    }
    if (selectedStockItem && qty > Number(selectedStockItem.stock || selectedStockItem.current_stock || 0)) {
      await showConfirm('Jumlah sisa stok bermasalah tidak boleh melebihi stok gudang saat ini.', {
        title: 'Jumlah melebihi stok',
        confirmText: 'Mengerti',
        cancelText: '',
        tone: 'warning',
      });
      return;
    }

    setSaving(true);
    try {
      await createStockIssue({
        ...form,
        qty,
      });
      setForm(emptyForm);
      setMode('reported');
      setPage(1);
      await showConfirm('Sisa stok berhasil dicatat dan masuk daftar menunggu review.', {
        title: 'Berhasil dicatat',
        confirmText: 'OK',
        cancelText: '',
      });
      await refresh();
    } catch (err) {
      await showConfirm(err.response?.data?.message || 'Sisa stok gagal dicatat. Silakan coba lagi.', {
        title: 'Gagal mencatat',
        confirmText: 'OK',
        cancelText: '',
        tone: 'danger',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResolve = async (issue) => {
    const notes = await showPrompt(`Catatan penyelesaian untuk ${issue.item_name}:`, {
      title: 'Selesaikan Sisa Stok',
      placeholder: 'Contoh: stok dipisahkan dan dibuat penyesuaian gudang.',
      confirmText: 'Selesaikan',
      cancelText: 'Batal',
    });
    if (notes === null) return;
    try {
      await resolveStockIssue(issue.id, { resolution_notes: notes });
      await refresh();
    } catch (err) {
      await showConfirm(err.response?.data?.message || 'Gagal menyelesaikan data sisa stok.', {
        title: 'Gagal',
        confirmText: 'OK',
        cancelText: '',
        tone: 'danger',
      });
    }
  };

  const handleReject = async (issue) => {
    const reasonText = await showPrompt(`Alasan menolak laporan ${issue.item_name}:`, {
      title: 'Tolak Laporan Sisa Stok',
      placeholder: 'Contoh: data duplikat / jumlah tidak sesuai.',
      confirmText: 'Tolak',
      cancelText: 'Batal',
      tone: 'danger',
    });
    if (reasonText === null) return;
    try {
      await rejectStockIssue(issue.id, { rejection_reason: reasonText });
      await refresh();
    } catch (err) {
      await showConfirm(err.response?.data?.message || 'Gagal menolak laporan sisa stok.', {
        title: 'Gagal',
        confirmText: 'OK',
        cancelText: '',
        tone: 'danger',
      });
    }
  };

  return (
    <section data-tour="stock-issues" className="space-y-5">
      <div data-tour="stock-issues-header" className="rounded-3xl border border-slate-700/60 bg-slate-800/70 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.22em] text-orange-300">Sisa Stok</p>
            <h2 className="mt-2 text-2xl font-black text-white">Tracking stok expired, rusak, atau hilang</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              Gunakan tab ini untuk mencatat stok bahan yang tidak layak dipakai, kadaluarsa, rusak, selisih fisik, atau hilang.
              Data ini membantu admin melacak penyebab selisih stok sebelum dilakukan penyesuaian gudang.
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            data-tour="stock-issues-refresh"
            className="rounded-2xl border border-orange-500/30 px-4 py-3 text-sm font-black text-orange-300 transition hover:bg-orange-500/10"
          >
            Refresh Data
          </button>
        </div>

        <div data-tour="stock-issues-summary" className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard title="Total laporan" value={summary?.total_issues} sub="Semua sisa stok" className="border-sky-500/20 bg-sky-500/10 text-sky-200" />
          <SummaryCard title="Menunggu" value={summary?.pending_count} sub="Perlu review admin" className="border-yellow-500/20 bg-yellow-500/10 text-yellow-200" />
          <SummaryCard title="Selesai" value={summary?.resolved_count} sub="Sudah ditindaklanjuti" className="border-emerald-500/20 bg-emerald-500/10 text-emerald-200" />
          <SummaryCard title="Ditolak" value={summary?.rejected_count} sub="Tidak diproses" className="border-red-500/20 bg-red-500/10 text-red-200" />
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <form data-tour="stock-issues-form" onSubmit={submitIssue} className="rounded-3xl border border-slate-700/60 bg-slate-800/80 p-5">
          <h3 className="text-lg font-black text-white">Catat Sisa Stok</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Laporan ini tidak langsung mengurangi stok. Admin tetap perlu review agar audit stok lebih jelas.
          </p>

          <div className="mt-5 space-y-4">
            <div data-tour="stock-issues-item-field">
              <label className="mb-1 block text-xs font-semibold text-slate-500">Bahan baku</label>
              <select
                value={form.stock_item_id}
                onChange={(event) => setForm((prev) => ({ ...prev, stock_item_id: event.target.value }))}
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none focus:border-orange-500"
              >
                <option value="">Pilih bahan stok...</option>
                {stockItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · Stok {fmtQty(item.stock || item.current_stock)} {item.unit}
                  </option>
                ))}
              </select>
            </div>

            <div data-tour="stock-issues-qty-unit-fields" className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">Jumlah bermasalah</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.qty}
                  onChange={(event) => setForm((prev) => ({ ...prev, qty: event.target.value }))}
                  className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none focus:border-orange-500"
                  placeholder="Contoh: 5"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">Satuan</label>
                <input
                  value={form.unit}
                  onChange={(event) => setForm((prev) => ({ ...prev, unit: event.target.value }))}
                  className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none focus:border-orange-500"
                  placeholder="gram / ml / pcs"
                />
              </div>
            </div>

            <div data-tour="stock-issues-reason-field">
              <label className="mb-1 block text-xs font-semibold text-slate-500">Alasan</label>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(reasonMeta).map(([key, meta]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, reason: key }))}
                    data-tour={`stock-issues-reason-${key}`}
                    className={`rounded-xl border px-3 py-3 text-left text-xs font-black transition ${
                      form.reason === key
                        ? meta.className
                        : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600'
                    }`}
                  >
                    <span className="mr-1">{meta.icon}</span>{meta.label}
                  </button>
                ))}
              </div>
            </div>

            <div data-tour="stock-issues-description-field">
              <label className="mb-1 block text-xs font-semibold text-slate-500">Deskripsi</label>
              <textarea
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                className="min-h-24 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none focus:border-orange-500"
                placeholder="Contoh: warna berubah, bau tidak normal, kemasan bocor, selisih saat opname..."
              />
            </div>

            <div data-tour="stock-issues-comments-field">
              <label className="mb-1 block text-xs font-semibold text-slate-500">Catatan tambahan</label>
              <textarea
                value={form.comments}
                onChange={(event) => setForm((prev) => ({ ...prev, comments: event.target.value }))}
                className="min-h-20 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none focus:border-orange-500"
                placeholder="Opsional: lokasi penyimpanan, nama staff, hasil pengecekan..."
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              data-tour="stock-issues-submit-button"
              className="w-full rounded-2xl bg-orange-500 px-4 py-3 text-sm font-black text-white shadow-lg shadow-orange-500/20 transition hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Menyimpan...' : 'Catat Sisa Stok'}
            </button>
          </div>
        </form>

        <div data-tour="stock-issues-list" className="rounded-3xl border border-slate-700/60 bg-slate-800/80 p-5">
          <div data-tour="stock-issues-filters" className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {[
                { id: 'reported', label: 'Menunggu' },
                { id: 'all', label: 'Semua' },
                { id: 'history', label: 'Riwayat' },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setMode(item.id);
                    setPage(1);
                  }}
                  className={`rounded-xl px-4 py-2 text-xs font-black transition ${
                    mode === item.id
                      ? 'bg-orange-500 text-white'
                      : 'border border-slate-700 bg-slate-900 text-slate-400 hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <select
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setPage(1);
              }}
              className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm text-white outline-none focus:border-orange-500"
            >
              <option value="">Semua alasan</option>
              {Object.entries(reasonMeta).map(([key, meta]) => (
                <option key={key} value={key}>{meta.label}</option>
              ))}
            </select>
          </div>

          <div data-tour="stock-issues-items" className="mt-5 space-y-3">
            {loading ? (
              <div className="rounded-2xl border border-slate-700 bg-slate-900 p-8 text-center text-sm text-slate-400">
                Memuat sisa stok...
              </div>
            ) : issues.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center">
                <p className="font-black text-white">Belum ada data sisa stok</p>
                <p className="mt-1 text-sm text-slate-500">Catat stok expired, rusak, hilang, atau selisih fisik dari form di kiri.</p>
              </div>
            ) : issues.map((issue) => (
              <article key={issue.id} data-tour="stock-issues-card" className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <IssueBadge type="reason" value={issue.reason} />
                      <IssueBadge type="status" value={issue.status} />
                    </div>
                    <h3 className="mt-3 text-lg font-black text-white">{issue.item_name}</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      {fmtQty(issue.qty)} {issue.unit} · {issue.issue_code}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Dilaporkan {formatDateTime(issue.reported_at)} oleh {issue.reported_by_name || '-'}
                    </p>
                  </div>
                  {isAdmin && issue.status === 'reported' && (
                    <div data-tour="stock-issues-admin-actions" className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => handleResolve(issue)}
                        className="rounded-xl bg-emerald-500/15 px-3 py-2 text-xs font-black text-emerald-200 transition hover:bg-emerald-500/25"
                      >
                        Selesaikan
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReject(issue)}
                        className="rounded-xl bg-red-500/15 px-3 py-2 text-xs font-black text-red-200 transition hover:bg-red-500/25"
                      >
                        Tolak
                      </button>
                    </div>
                  )}
                </div>

                {(issue.description || issue.comments || issue.resolution_notes) && (
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {issue.description && (
                      <div className="rounded-xl bg-slate-800/70 p-3">
                        <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Deskripsi</p>
                        <p className="mt-1 text-sm leading-6 text-slate-300">{issue.description}</p>
                      </div>
                    )}
                    {issue.comments && (
                      <div className="rounded-xl bg-slate-800/70 p-3">
                        <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Catatan</p>
                        <p className="mt-1 text-sm leading-6 text-slate-300">{issue.comments}</p>
                      </div>
                    )}
                    {issue.resolution_notes && (
                      <div className="rounded-xl bg-emerald-500/10 p-3 lg:col-span-2">
                        <p className="text-xs font-black uppercase tracking-[0.14em] text-emerald-300">Catatan penyelesaian</p>
                        <p className="mt-1 text-sm leading-6 text-emerald-100">{issue.resolution_notes}</p>
                      </div>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>

          <div data-tour="stock-issues-pagination" className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/60 pt-4">
            <button
              type="button"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={page <= 1}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-black text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Sebelumnya
            </button>
            <span className="text-sm font-semibold text-slate-500">Halaman {page} dari {totalPages}</span>
            <button
              type="button"
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              disabled={page >= totalPages}
              className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-black text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Berikutnya
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
