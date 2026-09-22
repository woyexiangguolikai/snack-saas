import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { BizError, ERR } from './errors';
import { AppLogger, sanitizeForLog } from './logger';

/**
 * 统一错误出口。
 * 前端按 `code` 分支，不解析 `message` —— 文案会改，错误码不会。
 * 出参同样过脱敏：错误上下文里最容易顺手把整条记录带出去。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{ method: string; originalUrl: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let payload: { code: string; message: string } = {
      code: ERR.INTERNAL,
      message: '服务异常，请稍后再试',
    };

    if (exception instanceof BizError) {
      status = exception.getStatus();
      payload = { code: exception.code, message: exception.message };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body) {
        const b = body as { code: string; message: string };
        payload = { code: b.code, message: b.message };
      } else {
        payload = { code: ERR.VALIDATION_FAILED, message: exception.message };
      }
    } else {
      const msg = exception instanceof Error ? exception.message : String(exception);
      this.logger.error('未捕获异常', { path: req.originalUrl, message: msg });
    }

    res.status(status).json({
      ok: false,
      error: payload,
      detail: sanitizeForLog(exception instanceof Error ? exception.stack : undefined),
    });
  }
}
