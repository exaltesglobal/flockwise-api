// The church office's side of church networks and dioceses: join with the code the network office
// gives, choose whether to share giving totals, or leave. Only totals are shared (network.ts).
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { ChurchNetworkHost } from '../types.js';

function host(ctx: Ctx): ChurchNetworkHost {
  if (!ctx.env.network) throw new ApiError(404, 'not_available', 'Church networks are not available on this server.');
  return ctx.env.network;
}

export function registerNetworkLink(r: Router) {
  r.get('/admin/networks', { perm: 'settings' }, (ctx) => ({ available: !!ctx.env.network, networks: ctx.env.network?.list() ?? [] }));
  r.get('/admin/networks/preview', { perm: 'settings' }, (ctx) => {
    const n = host(ctx).preview(String(ctx.query.code ?? ''));
    if (!n) throw new ApiError(404, 'not_found', 'That join code is not right. Ask your network office for it again.');
    return n;
  });
  r.post('/admin/networks/join', { perm: 'settings' }, (ctx) => {
    const n = host(ctx).join(String(ctx.body.code ?? ''), !!ctx.body.shareGiving, ctx.staff?.name ?? 'Church office');
    ctx.audit('joined', 'network', n.id, `Joined ${n.name}${n.shareGiving ? ', sharing giving totals' : ''}`);
    return n;
  });
  r.patch('/admin/networks/:id', { perm: 'settings' }, (ctx) => {
    const n = host(ctx).update(ctx.params[0], !!ctx.body.shareGiving);
    ctx.audit('updated', 'network', n.id, `${n.shareGiving ? 'Started' : 'Stopped'} sharing giving totals with ${n.name}`);
    return n;
  });
  r.del('/admin/networks/:id', { perm: 'settings' }, (ctx) => {
    const name = host(ctx).list().find((n) => n.id === ctx.params[0])?.name ?? 'a network';
    host(ctx).leave(ctx.params[0]);
    ctx.audit('left', 'network', ctx.params[0], `Left ${name}`);
    return undefined;
  });
}
