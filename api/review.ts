/**
 * DEPRECATED — This endpoint no longer processes requests.
 *
 * The review functionality is handled by /api/review-text, which requires
 * authentication and applies all security controls.
 */
export default function handler(_req: any, res: any) {
  return res.status(410).json({
    code: 'ENDPOINT_DEPRECATED',
    message: 'Este endpoint não está mais disponível.',
  });
}
