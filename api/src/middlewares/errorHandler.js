/**
 * Global Error Handler Middleware
 * ---------------------------------------------------------------
 * Pasang PALING AKHIR setelah semua route.
 * Format error response konsisten untuk seluruh API.
 */

const errorHandler = (err, req, res, next) => {
  // Logging — ganti dengan logger proper (winston/pino) di production
  console.error('[ERROR]', {
    path: req.path,
    method: req.method,
    name: err.name,
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });

  // Supabase / Postgres error shape
  if (err.code && /^(22|23|42)/.test(String(err.code))) {
    return res.status(400).json({
      success: false,
      error: 'DATABASE_ERROR',
      message: err.message,
      code: err.code,
    });
  }

  // Custom AppError
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.code || 'APP_ERROR',
      message: err.message,
    });
  }

  // Default 500
  return res.status(500).json({
    success: false,
    error: 'INTERNAL_SERVER_ERROR',
    message:
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong'
        : err.message,
  });
};

/**
 * Custom Application Error class
 */
class AppError extends Error {
  constructor(message, statusCode = 400, code = 'APP_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'AppError';
  }
}

/**
 * 404 handler — pasang sebelum errorHandler
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} not found`,
  });
};

module.exports = { errorHandler, notFoundHandler, AppError };
