import api from './axios';

// Auth
export const login        = (data)       => api.post('/auth/login', data, { feedback: false });
export const getMe        = ()           => api.get('/auth/me');
export const registerUser = (data)       => api.post('/auth/register', data);
export const getActiveUsers    = ()       => api.get('/auth/active');
export const logoutUser        = ()       => api.post('/auth/logout', null, { feedback: false });
export const getUsers = (params) => api.get('/auth/users', { params });
export const getCashierSchedules = (params) => api.get('/auth/schedules', { params });
export const createCashierSchedule = (data) => api.post('/auth/schedules', data);
export const updateCashierSchedule = (id, data) => api.put(`/auth/schedules/${id}`, data);
export const deleteCashierSchedule = (id) => api.delete(`/auth/schedules/${id}`);

// Branches
export const getPublicBranches = () => api.get('/branches/public');
export const getBranches = () => api.get('/branches');
export const syncBranchesFromLanding = () => api.post('/branches/sync-from-landing');
export const setMyBranch = (branch_id) => api.put('/branches/me', { branch_id });

// Attendance
export const getWeeklyAttendance = (params) => api.get('/attendance/weekly', { params });
export const getStaffPerformance = (params) => api.get('/attendance/performance', { params });

// Products
export const getProducts    = (params)   => api.get('/products', { params });
export const createProduct  = (data)     => api.post('/products', data);
export const updateProduct  = (id, data) => api.put(`/products/${id}`, data);
export const deleteProduct  = (id)       => api.delete(`/products/${id}`);
export const getStockAllUsers   = ()      => api.get('/products/stock-all');
export const getMyStockProducts = ()      => api.get('/products/my-stock');
export const getStockByKasir = () => api.get('/products/stock-by-kasir');

// Categories
export const getCategories  = ()         => api.get('/categories');
export const createCategory = (data)     => api.post('/categories', data);
export const deleteCategory = (id)       => api.delete(`/categories/${id}`);

// Transactions
export const createTransaction = (data)  => api.post('/transactions', data, { feedback: false });
export const getTransactions   = (params)=> api.get('/transactions', { params });
export const getTransaction    = (id)    => api.get(`/transactions/${id}`);
export const deleteTransaction = (id, data = {}) => api.delete(`/transactions/${id}`, { data, feedback: false });

// Stock Items — Bahan Baku (BARU)
export const getStockItems    = ()       => api.get('/stock-items');
export const createStockItem  = (data)   => api.post('/stock-items', data);
export const updateStockItem  = (id, d)  => api.put(`/stock-items/${id}`, d);
export const deleteStockItem  = (id)     => api.delete(`/stock-items/${id}`);
export const stockItemIn      = (data)   => api.post('/stock-items/in', data);
export const getStockHistory  = (params) => api.get('/stock-items/history', { params });
export const getStockUnits = () => api.get('/stock-items/units');

// Main Stock
export const getMainStockSummary  = (params) => api.get('/main-stock/summary', { params });
export const getMainStockMonthly  = (params) => api.get('/main-stock/monthly', { params });
export const getMainStockPriceTrends = (params) => api.get('/main-stock/price-trends', { params });
// export const getMainStockDaily    = (params) => api.get('/main-stock/daily',   { params });
// Di lib/api.js
export const getMainStockDaily = (params) => api.get('/main-stock/daily', { params });
export const addStockPurchase     = (data)   => api.post('/main-stock/purchase', data, { feedback: false });

// Stock Requests
export const submitStockRequest  = (data)   => api.post('/stock-requests', data, { feedback: false });
export const deleteStockRequest  = (id)     => api.delete(`/stock-requests/${id}`);
export const getAllStockRequests  = (params) => api.get('/stock-requests', { params });
export const getMyStockRequests  = (params) => api.get('/stock-requests/my', { params });
export const getApprovedStockRequests = (params) => api.get('/stock-requests/approved-for-pos', { params });
export const approveStockRequest = (id, data) => api.put(`/stock-requests/${id}/approve`, data, { feedback: false });
export const updateStockPurchase = (id, data) => api.put(`/main-stock/purchase/${id}`, data);
export const deleteStockPurchase = (id)       => api.delete(`/main-stock/purchase/${id}`);
export const addManualStockOut   = (data)      => api.post('/main-stock/out', data, { feedback: false });
export const resubmitStockRequest = (id) => api.put(`/stock-requests/${id}/resubmit`);

// Stock Issues / Sisa Stok Bermasalah
export const getStockIssueSummary = () => api.get('/stock-issues/summary');
export const getStockIssues = (params) => api.get('/stock-issues', { params });
export const createStockIssue = (data) => api.post('/stock-issues', data, { feedback: false });
export const resolveStockIssue = (id, data) => api.put(`/stock-issues/${id}/resolve`, data, { feedback: false });
export const rejectStockIssue = (id, data) => api.put(`/stock-issues/${id}/reject`, data, { feedback: false });

// Reports
export const getTodayStats   = ()       => api.get('/reports/today');
export const getDiscountSummary = (params) => api.get('/reports/discount-summary', { params });
export const getSalesReport  = (params) => api.get('/reports/sales', { params });
export const getYearlyStats  = (params) => api.get('/reports/yearly', { params });
export const getBestSelling  = (params) => api.get('/reports/best-selling', { params });
export const getLowStock     = (params) => api.get('/reports/stock-low', { params });
export const getTransactionYears = () => api.get('/reports/years');
export const getSalesByProduct = (params) => api.get('/reports/sales-by-product', { params });
export const getBusinessAnalysis = (params) => api.get('/reports/business-analysis', { params });
export const downloadBusinessAnalysisPdf = (params) =>
  api.get('/reports/business-analysis/pdf', {
    params,
    responseType: 'blob',
    feedback: true,
    successMessage: 'Laporan PDF berhasil dibuat dan siap diunduh.',
  });

// Voucher & discount management
export const getDiscountPrograms = () => api.get('/discounts');
export const getActiveDiscountPrograms = (params) => api.get('/discounts/active', { params, feedback: false });
export const previewDiscount = (data) => api.post('/discounts/preview', data, { feedback: false });
export const validateReviewVoucher = (data) => api.post('/discounts/review-voucher/validate', data, { feedback: false });
export const createDiscountProgram = (data) => api.post('/discounts', data);
export const updateDiscountProgram = (id, data) => api.put(`/discounts/${id}`, data);
export const deleteDiscountProgram = (id) => api.delete(`/discounts/${id}`);
export const hardDeleteDiscountProgram = (id) => api.delete(`/discounts/${id}`, { params: { hard: 1 } });

// Payment management
export const getPublicPaymentMethods = () => api.get('/payments/public', { feedback: false });
export const getPaymentMethods = () => api.get('/payments');
export const createPaymentMethod = (data) => api.post('/payments', data, {
  headers: { 'Content-Type': 'multipart/form-data' },
});
export const updatePaymentMethod = (id, data) => api.put(`/payments/${id}`, data, {
  headers: { 'Content-Type': 'multipart/form-data' },
});
export const deletePaymentMethod = (id) => api.delete(`/payments/${id}`);
export const hardDeletePaymentMethod = (id) => api.delete(`/payments/${id}`, { params: { hard: 1 } });

// Settings / Website Configuration
export const getWebsiteSettings = ()     => api.get('/settings');
export const getWebsiteSetting  = (key)  => api.get(`/settings/${key}`);
export const updateWebsiteSetting = (data) => api.put('/settings', data);
export const uploadWebsiteImage = (formData) => api.put('/settings/upload', formData, {
  headers: { 'Content-Type': 'multipart/form-data' }
});
export const uploadWebsiteAsset = (formData) => api.put('/settings/upload-asset', formData, {
  headers: { 'Content-Type': 'multipart/form-data' }
});
export const bulkUpdateWebsiteSettings = (settings) => api.put('/settings/bulk-update', settings);

// AI Chat dengan OpenRouter (model selection dan session context)
export const sendAIQuery = (
  message,
  conversationHistory = [],
  sessionId,
  options = {}
) =>
  api.post('/ai-chat/query', {
    message,
    conversationHistory,
    sessionId,
    modelId: options.modelId,
    maxTokens: options.maxTokens,
  }, { feedback: false });

export const checkAIChatHealth = () => api.get('/ai-chat/health');
export const getAIChatModels = () => api.get('/ai-chat/models');

export const clearAIChatSession = (sessionId) => api.delete(`/ai-chat/session/${sessionId}`, { feedback: false });

export const getAIChatSessions = () => api.get('/ai-chat/sessions');

// Customer table ordering
export const getPublicDiningTables = (params) => api.get('/customer/tables', { params });
export const getPublicTableQueue = (params) => api.get('/customer/tables/queue', { params });
export const joinPublicTableQueue = (data) => api.post('/customer/tables/queue', data);
export const claimPublicTableQueue = (queueToken) => api.post(`/customer/tables/queue/${queueToken}/claim`, {}, { feedback: false });
export const getDiningTableByToken = (token, params) => api.get(`/customer/tables/${token}`, { params });
export const createTableSession = (token, data) => api.post(`/customer/tables/${token}/session`, data, { feedback: false });
export const releaseTableSession = (sessionToken) => api.post(`/customer/tables/session/${sessionToken}/release`, {}, { feedback: false });
export const getCustomerMenu = (params) => api.get('/customer/menu', { params });
export const createCustomerOrder = (data) => api.post('/customer/orders', data);
export const getCustomerOrder = (orderCode) => api.get(`/customer/orders/${orderCode}`);
export const submitCustomerPaymentProof = (orderCode, data) => api.post(`/customer/orders/${orderCode}/payment-proof`, data, {
  headers: { 'Content-Type': 'multipart/form-data' },
  feedback: false,
});
export const submitCustomerOrderReview = (orderCode, data) =>
  api.post(`/customer/orders/${orderCode}/review`, data);
export const skipCustomerOrderReview = (orderCode) =>
  api.post(`/customer/orders/${orderCode}/review-skip`, {}, { feedback: false });

// Staff customer order management
export const getManagedDiningTables = () => api.get('/customer/tables/manage');
export const createDiningTable = (data) => api.post('/customer/tables', data);
export const updateDiningTable = (id, data) => api.put(`/customer/tables/${id}`, data);
export const deleteDiningTable = (id) => api.delete(`/customer/tables/${id}`);
export const getCustomerOrders = (params) => api.get('/customer/orders', { params });
export const updateCustomerOrderStatus = (id, data, config = {}) => api.put(`/customer/orders/${id}/status`, data, config);
