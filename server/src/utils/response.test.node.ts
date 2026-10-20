import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Response } from 'express';
import { ResponseHelper, ApiResponse } from './response';

// Mock Response object
function createMockResponse(): { res: Partial<Response> & { jsonData: any; statusCode: number } } {
  const res: Partial<Response> & { jsonData: any; statusCode: number } = {
    statusCode: 200,
    jsonData: null,
    status(code: number) {
      this.statusCode = code;
      return this as Response;
    },
    json(data: any) {
      this.jsonData = data;
      return this as Response;
    },
    send() {
      return this as Response;
    },
  };
  
  return { res };
}

describe('ResponseHelper', () => {
  describe('success', () => {
    it('should return success response with code 0', () => {
      const { res } = createMockResponse();
      ResponseHelper.success(res as Response, { id: 1 }, 'Success');
      
      assert.strictEqual(res.jsonData.code, 0);
      assert.strictEqual(res.jsonData.msg, 'Success');
      assert.deepStrictEqual(res.jsonData.data, { id: 1 });
      assert.ok(res.jsonData.timestamp);
    });

    it('should return success response without data', () => {
      const { res } = createMockResponse();
      ResponseHelper.success(res as Response, undefined, 'Success');
      
      assert.strictEqual(res.jsonData.code, 0);
      assert.strictEqual(res.jsonData.msg, 'Success');
      assert.strictEqual(res.jsonData.data, undefined);
    });
  });

  describe('error', () => {
    it('should return error response with status code', () => {
      const { res } = createMockResponse();
      ResponseHelper.error(res as Response, 'Bad Request', 400);
      
      assert.strictEqual(res.jsonData.code, 400);
      assert.strictEqual(res.jsonData.msg, 'Bad Request');
    });

    it('should return error response with data', () => {
      const { res } = createMockResponse();
      ResponseHelper.error(res as Response, 'Validation Error', 422, { field: 'email' });
      
      assert.strictEqual(res.jsonData.code, 422);
      assert.strictEqual(res.jsonData.msg, 'Validation Error');
      assert.deepStrictEqual(res.jsonData.data, { field: 'email' });
    });
  });

  describe('paginated', () => {
    it('should return paginated response', () => {
      const { res } = createMockResponse();
      const items = [{ id: 1 }, { id: 2 }];
      ResponseHelper.paginated(res as Response, items, 100, 1, 10);
      
      assert.strictEqual(res.jsonData.code, 0);
      assert.strictEqual(res.jsonData.data.items.length, 2);
      assert.strictEqual(res.jsonData.data.pagination.total, 100);
      assert.strictEqual(res.jsonData.data.pagination.page, 1);
      assert.strictEqual(res.jsonData.data.pagination.pageSize, 10);
      assert.strictEqual(res.jsonData.data.pagination.totalPages, 10);
    });
  });

  describe('convenience methods', () => {
    it('badRequest should return 400', () => {
      const { res } = createMockResponse();
      ResponseHelper.badRequest(res as Response, 'Invalid input');
      
      assert.strictEqual(res.jsonData.code, 400);
      assert.strictEqual(res.jsonData.msg, 'Invalid input');
    });

    it('unauthorized should return 401', () => {
      const { res } = createMockResponse();
      ResponseHelper.unauthorized(res as Response);
      
      assert.strictEqual(res.jsonData.code, 401);
      assert.strictEqual(res.jsonData.msg, 'Unauthorized');
    });

    it('forbidden should return 403', () => {
      const { res } = createMockResponse();
      ResponseHelper.forbidden(res as Response);
      
      assert.strictEqual(res.jsonData.code, 403);
      assert.strictEqual(res.jsonData.msg, 'Forbidden');
    });

    it('notFound should return 404', () => {
      const { res } = createMockResponse();
      ResponseHelper.notFound(res as Response, 'Resource not found');
      
      assert.strictEqual(res.jsonData.code, 404);
      assert.strictEqual(res.jsonData.msg, 'Resource not found');
    });

    it('internalError should return 500', () => {
      const { res } = createMockResponse();
      ResponseHelper.internalError(res as Response, 'Server error');
      
      assert.strictEqual(res.jsonData.code, 500);
      assert.strictEqual(res.jsonData.msg, 'Server error');
    });
  });
});
