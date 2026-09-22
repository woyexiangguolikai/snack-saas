/**
 * 后台路由。
 *
 * 页面编号沿用需求文档的 W-01~W-11，路由名与之一一对应 ——
 * 需求评审时说的"W-05 库存矩阵"要能在代码里直接搜到，中间不隔一层翻译。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { isLoggedIn, restore } from '@/stores/session';
import { isPlatformLoggedIn, restorePlatform } from '@/stores/platform';

restore();
restorePlatform();

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/pages/Login.vue'), meta: { public: true } },
  { path: '/', name: 'W-01', component: () => import('@/pages/Dashboard.vue'), meta: { title: '工作台' } },
  { path: '/buildings', name: 'W-02', component: () => import('@/pages/Buildings.vue'), meta: { title: '楼栋与配送' } },
  { path: '/time-window', name: 'W-03', component: () => import('@/pages/TimeWindow.vue'), meta: { title: '时间窗配置' } },
  { path: '/products', name: 'W-04', component: () => import('@/pages/Products.vue'), meta: { title: '商品管理' } },
  { path: '/stock', name: 'W-05', component: () => import('@/pages/StockMatrix.vue'), meta: { title: '库存矩阵' } },
  { path: '/stock-logs', name: 'W-06', component: () => import('@/pages/StockLogs.vue'), meta: { title: '库存流水与调拨' } },
  { path: '/orders', name: 'W-07', component: () => import('@/pages/Orders.vue'), meta: { title: '订单管理' } },
  { path: '/import', name: 'W-08', component: () => import('@/pages/Import.vue'), meta: { title: '批量导入' } },
  { path: '/settings', name: 'W-09', component: () => import('@/pages/Settings.vue'), meta: { title: '店铺设置' } },
  { path: '/billing', name: 'W-10', component: () => import('@/pages/Billing.vue'), meta: { title: '账单与明细' } },
  { path: '/export', name: 'W-11', component: () => import('@/pages/Export.vue'), meta: { title: '数据导出' } },

  /* ------------------------------------------------------------ 平台后台 */

  { path: '/platform/login', name: 'platform-login', component: () => import('@/pages/platform/Login.vue'), meta: { public: true, platform: true } },
  { path: '/platform', name: 'P-01', component: () => import('@/pages/platform/Tenants.vue'), meta: { title: '租户管理', platform: true } },
  // `new` 必须排在 `:tenantCode` 之前 —— 否则"新建"会被当成一个叫 new 的租户号
  { path: '/platform/tenants/new', name: 'P-03', component: () => import('@/pages/platform/TenantNew.vue'), meta: { title: '创建租户', platform: true } },
  { path: '/platform/tenants/:tenantCode', name: 'P-02', component: () => import('@/pages/platform/TenantDetail.vue'), meta: { title: '租户详情', platform: true } },
  { path: '/platform/pipeline', name: 'P-04', component: () => import('@/pages/platform/Pipeline.vue'), meta: { title: '上线流水线', platform: true } },
  { path: '/platform/rework', name: 'P-05', component: () => import('@/pages/platform/Rework.vue'), meta: { title: '返工队列', platform: true } },
  { path: '/platform/versions', name: 'P-06', component: () => import('@/pages/platform/Versions.vue'), meta: { title: '版本与发布', platform: true } },
  { path: '/platform/push', name: 'P-07', component: () => import('@/pages/platform/Push.vue'), meta: { title: '批量推送', platform: true } },
  { path: '/platform/gates', name: 'P-08', component: () => import('@/pages/platform/Gates.vue'), meta: { title: '两道闸门', platform: true } },
  { path: '/platform/reconcile', name: 'P-09', component: () => import('@/pages/platform/Reconcile.vue'), meta: { title: '对账报表', platform: true } },
  { path: '/platform/alerts', name: 'P-10', component: () => import('@/pages/platform/Alerts.vue'), meta: { title: '监控告警', platform: true } },
  { path: '/platform/tickets', name: 'P-11', component: () => import('@/pages/platform/Tickets.vue'), meta: { title: '工单', platform: true } },
  { path: '/platform/secrets', name: 'P-12', component: () => import('@/pages/platform/Secrets.vue'), meta: { title: '密钥管理', platform: true } },
  { path: '/platform/schools', name: 'P-13', component: () => import('@/pages/platform/Schools.vue'), meta: { title: '学校与楼栋模板', platform: true } },

  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  // BASE_URL 由 vite 的 `base` 注入 —— 与之保持同一个值，
  // 否则部署到子路径（/admin/）时刷新子页面会 404
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.beforeEach((to) => {
  // 平台区与商户区各管各的登录态：**不能共用一份守卫判断**。
  // 共用的话，"平台密钥过期"会把人送回商户登录页 —— 而那里根本没有他要的东西
  if (to.meta.platform) {
    if (!to.meta.public && !isPlatformLoggedIn()) return { name: 'platform-login' };
    return true;
  }
  if (!to.meta.public && !isLoggedIn()) {
    return { name: 'login', query: { next: to.fullPath } };
  }
  return true;
});

export interface NavItem {
  to: string;
  label: string;
  code: string;
  group: string;
}

/** 侧边栏分组 —— "批量与配置"是网页后台相对手机端的立身之本，单独成组便于找 */
export const NAV: NavItem[] = [
  { to: '/', label: '工作台', code: 'W-01', group: '日常' },
  { to: '/orders', label: '订单管理', code: 'W-07', group: '日常' },
  { to: '/stock', label: '库存矩阵', code: 'W-05', group: '日常' },
  { to: '/products', label: '商品管理', code: 'W-04', group: '商品' },
  { to: '/stock-logs', label: '库存流水与调拨', code: 'W-06', group: '商品' },
  { to: '/import', label: '批量导入', code: 'W-08', group: '商品' },
  { to: '/buildings', label: '楼栋与配送', code: 'W-02', group: '配置' },
  { to: '/time-window', label: '时间窗配置', code: 'W-03', group: '配置' },
  { to: '/settings', label: '店铺设置', code: 'W-09', group: '配置' },
  { to: '/billing', label: '账单与明细', code: 'W-10', group: '账目' },
  { to: '/export', label: '数据导出', code: 'W-11', group: '账目' },
];

/** 平台后台侧边栏 —— 分组按"每天要看 / 开工要看 / 收钱 / 兜底"来切，不按页面编号 */
export const PLATFORM_NAV: NavItem[] = [
  { to: '/platform', label: '租户管理', code: 'P-01', group: '日常' },
  { to: '/platform/pipeline', label: '上线流水线', code: 'P-04', group: '日常' },
  { to: '/platform/rework', label: '返工队列', code: 'P-05', group: '日常' },
  { to: '/platform/tenants/new', label: '创建租户', code: 'P-03', group: '上线' },
  { to: '/platform/versions', label: '版本与发布', code: 'P-06', group: '上线' },
  { to: '/platform/push', label: '批量推送', code: 'P-07', group: '上线' },
  { to: '/platform/secrets', label: '密钥管理', code: 'P-12', group: '上线' },
  { to: '/platform/schools', label: '学校与楼栋模板', code: 'P-13', group: '上线' },
  { to: '/platform/gates', label: '两道闸门', code: 'P-08', group: '收钱' },
  { to: '/platform/reconcile', label: '对账报表', code: 'P-09', group: '收钱' },
  { to: '/platform/alerts', label: '监控告警', code: 'P-10', group: '兜底' },
  { to: '/platform/tickets', label: '工单', code: 'P-11', group: '兜底' },
];
