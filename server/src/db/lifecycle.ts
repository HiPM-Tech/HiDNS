import { connect } from './dal/connection';

/**
 * 数据库生命周期入口（db 层内唯一对外出口）。
 *
 * service 层不允许直接 import `dal/connection`（见 db/index.ts 的分层说明），
 * 但周期性任务需要「连接丢失后重连」的兜底；从 `db/index` 走又会把整套业务适配器
 * 连同 `database` 一起加载进测试。这里只暴露连接管理，不带任何业务依赖。
 */
export const reconnectDatabase = connect;
