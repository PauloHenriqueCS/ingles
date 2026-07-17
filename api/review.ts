import { jsonError } from './_helpers';

export default function handler(req: any, res: any) {
  jsonError(res, 410, 'ENDPOINT_DEPRECATED', 'Este endpoint foi removido. Use /api/review-text.');
}
