/**
 * Dynadot Provider Module
 *
 * 文档：https://www.dynadot.com/domain/api-document（v2 RESTful + X-Signature）
 */
export { DynadotAdapter } from './adapter';
export {
  buildSignature as dynadotBuildSignature,
  buildStringToSign as dynadotBuildStringToSign,
  dynadotRequest,
  resolveDynadotConfig,
  type DynadotAuthConfig,
} from './auth';