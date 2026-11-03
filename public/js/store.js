// store.js — 前端唯一可变状态容器（不 import 任何 views/actions/main，避免循环依赖）
import { $ } from './utils/dom.js';
export const DATA = { state: null };
export let currentFiltered = [];
export const SELECTED = new Set();
export const GRAVE_SELECTED = new Set();
export let SORT = 'total_asc';
// 数值筛选运算符: latOp/speedOp/qualOp/successOp/onlineOp ∈ lte(≤) gte(≥) lt(<) gt(>) eq(=); 默认: 总延迟≤, 其余≥
const DEFAULT_FILTERS = {
  search: '',
  kind: 'all',
  status: 'all',
  latOp: 'lte',
  maxLatency: '',
  speedOp: 'gte',
  minSpeed: '',
  qualOp: 'gte',
  minQual: '',
  successOp: 'gte',
  minSuccess: '',
  onlineOp: 'gte',
  minOnline: '',
  colo: '',
  loc: '',
  onlyQuality: false,
};
export let FILTERS = { ...DEFAULT_FILTERS };
export const els = {
  tbody: $('#tbody'),
  tableWrap: $('#tableWrap'),
  emptyTip: $('#emptyTip'),
  selectAll: $('#selectAll'),
  selCount: $('#selCount'),
  btnDeleteSelected: $('#btnDeleteSelected'),
  btnCopyFiltered: $('#btnCopyFiltered'),
  filteredCount: $('#filteredCount'),
  statTotal: $('#statTotal'),
  statOnline: $('#statOnline'),
  statQuality: $('#statQuality'),
  statOffline: $('#statOffline'),
  statGithub: $('#statGithub'),
  statGithubSub: $('#statGithubSub'),
  progressBar: $('#progressBar'),
  progressText: $('#progressText'),
  footerVersion: $('#footerVersion'),
  btnAbort: $('#btnAbort'),
  btnCheck: $('#btnCheck'),
  btnUpload: $('#btnUpload'),
};
export function setCurrentFiltered(arr) {
  currentFiltered = arr;
}
export function setSort(v) {
  SORT = v;
}
export function resetFilters() {
  FILTERS = { ...DEFAULT_FILTERS };
}
// 刷新回调注入：切断 store/actions/events ↔ main 的循环依赖（与后端 setStateBuilder 同构）
let refreshFn = null;
export function setRefreshFn(fn) {
  refreshFn = fn;
}
export function refresh() {
  return refreshFn ? refreshFn() : Promise.resolve();
}
