const { validationResult } = require('express-validator');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const badRequest = (message, extra) => new HttpError(400, message, extra);
const forbidden = (message = 'Access denied') => new HttpError(403, message);
const notFound = (message = 'Not found') => new HttpError(404, message);
const conflict = (message, extra) => new HttpError(409, message, extra);

/** Wrap an async route so thrown errors reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Run after express-validator chains; responds 400 with the first message. */
const validate = (req, res, next) => {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  const errors = result.array();
  return res.status(400).json({ message: errors[0].msg === 'Invalid value' ? `Invalid ${errors[0].path}` : errors[0].msg, errors });
};

const PAGE_SIZES = [5, 10, 20, 50, 100];

function parsePagination(query) {
  const paginate = query.page !== undefined || query.limit !== undefined;
  const page = Math.max(1, Number(query.page) || 1);
  const limit = PAGE_SIZES.includes(Number(query.limit)) ? Number(query.limit) : 20;
  return { paginate, page, limit, offset: (page - 1) * limit };
}

function pageResult(items, total, { page, limit }) {
  return {
    items,
    total: Number(total) || 0,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil((Number(total) || 0) / limit)),
  };
}

const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

module.exports = {
  HttpError,
  badRequest,
  forbidden,
  notFound,
  conflict,
  asyncHandler,
  validate,
  parsePagination,
  pageResult,
  toBool,
  emptyToNull,
};
