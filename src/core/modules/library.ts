// Church library: the books on the shelf in the church office, how many copies, who has them and
// when they are due back. Members browse and ask for a book in the app; the keeper hands it over
// and marks it returned. Members get a reminder the day before it is due and once when overdue.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { LibraryBook, LibraryBookView, LibraryHub, LibraryLoan, LibraryLoanView, MyLibrary } from '../types.js';
import { permsOf } from '../perms.js';
import { find, fullName, localDate, normEmail, settings } from '../util.js';
import { notify } from './notify.js';

const DAY = 86_400_000;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const loanDays = (ctx: Ctx) => { const n = Number(ctx.db.get('meta', 'library:loanDays')?.value); return n >= 1 && n <= 120 ? n : 21; };
const loansOf = (ctx: Ctx, bookId: string) => ctx.db.all('libraryLoans').filter((l) => l.bookId === bookId);

function bookView(ctx: Ctx, b: LibraryBook): LibraryBookView {
  const loans = loansOf(ctx, b.id);
  const out = loans.filter((l) => l.status === 'out').length;
  return { ...b, out, available: Math.max(0, b.copies - out), requested: loans.filter((l) => l.status === 'requested').length, timesBorrowed: loans.filter((l) => l.status === 'out' || l.status === 'returned').length };
}

function loanView(ctx: Ctx, l: LibraryLoan): LibraryLoanView {
  const b = ctx.db.get('libraryBooks', l.bookId);
  const p = ctx.db.get('people', l.personId);
  return { ...l, title: b?.title ?? 'Removed book', author: b?.author ?? '', name: p ? fullName(p) : 'Removed person', phone: p?.phone ?? null, overdue: l.status === 'out' && !!l.dueOn && l.dueOn < localDate(ctx, ctx.now) };
}

function readBook(b: Record<string, unknown>, prev?: LibraryBook): Omit<LibraryBook, 'id' | 'addedAt'> {
  const title = b.title !== undefined ? clean(b.title, 160) : (prev?.title ?? '');
  if (!title) throw new ApiError(422, 'invalid', 'Give the book a title.', { title: 'Required' });
  return {
    title,
    author: b.author !== undefined ? clean(b.author, 120) : (prev?.author ?? ''),
    language: b.language !== undefined ? clean(b.language, 40) : (prev?.language ?? 'English'),
    category: b.category !== undefined ? clean(b.category, 40) : (prev?.category ?? ''),
    copies: b.copies !== undefined ? Math.max(0, Math.min(99, Math.round(Number(b.copies) || 0))) : (prev?.copies ?? 1),
    isbn: b.isbn !== undefined ? clean(b.isbn, 20).replace(/[^\dXx-]/g, '') : (prev?.isbn ?? ''),
    note: b.note !== undefined ? clean(b.note, 300) : (prev?.note ?? ''),
  };
}

function hub(ctx: Ctx): LibraryHub {
  const books = ctx.db.all('libraryBooks').map((b) => bookView(ctx, b)).sort((a, b) => a.title.localeCompare(b.title));
  const all = ctx.db.all('libraryLoans').map((l) => loanView(ctx, l));
  const loans = all.filter((l) => l.status === 'out').sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueOn ?? '').localeCompare(b.dueOn ?? ''));
  const requests = all.filter((l) => l.status === 'requested').sort((a, b) => (a.requestedAt ?? '').localeCompare(b.requestedAt ?? ''));
  return {
    books, loans, requests,
    settings: { loanDays: loanDays(ctx) },
    counts: { titles: books.length, copies: books.reduce((s, b) => s + b.copies, 0), out: loans.length, overdue: loans.filter((l) => l.overdue).length, requests: requests.length },
    categories: [...new Set(books.map((b) => b.category).filter(Boolean))].sort(),
  };
}

function keeperIds(ctx: Ctx): string[] {
  const out = new Set<string>();
  for (const s of ctx.db.all('staff')) {
    if (s.status !== 'active' || !permsOf(ctx.db, s).includes('people.edit')) continue;
    const p = (s.personId && ctx.db.get('people', s.personId)) || ctx.db.all('people').find((x) => normEmail(x.email) === normEmail(s.email));
    if (p) out.add(p.id);
  }
  return [...out];
}

function lend(ctx: Ctx, book: LibraryBook, personId: string, existing?: LibraryLoan): LibraryLoan {
  if (bookView(ctx, book).available < 1) throw new ApiError(409, 'unavailable', `All copies of ${book.title} are out.`);
  const today = localDate(ctx, ctx.now);
  const base: LibraryLoan = existing ?? { id: ctx.id('ln'), bookId: book.id, personId, status: 'out', requestedAt: null, borrowedOn: null, dueOn: null, returnedOn: null, remindedFor: null, via: 'office' };
  return ctx.db.put('libraryLoans', { ...base, status: 'out', borrowedOn: today, dueOn: addDays(today, loanDays(ctx)), remindedFor: null });
}

function mine(ctx: Ctx): MyLibrary {
  const me = ctx.me();
  const my = ctx.db.all('libraryLoans').filter((l) => l.personId === me && (l.status === 'requested' || l.status === 'out'));
  return {
    books: ctx.db.all('libraryBooks').filter((b) => b.copies > 0).map((b) => bookView(ctx, b)).sort((a, b) => a.title.localeCompare(b.title))
      .map((b) => ({ id: b.id, title: b.title, author: b.author, language: b.language, category: b.category, available: b.available > 0, mine: my.find((l) => l.bookId === b.id)?.status ?? null })),
    loans: my.map((l) => loanView(ctx, l)).map((l) => ({ id: l.id, bookId: l.bookId, title: l.title, status: l.status, dueOn: l.dueOn, overdue: l.overdue })),
    loanDays: loanDays(ctx),
  };
}

/** Daily: the day before a book is due, and once when it becomes overdue. */
export async function libraryReminders(ctx: Ctx, today: string) {
  const church = settings(ctx).name;
  for (const l of ctx.db.all('libraryLoans')) {
    if (l.status !== 'out' || !l.dueOn) continue;
    const stage = l.dueOn === addDays(today, 1) ? `due:${l.dueOn}` : l.dueOn < today ? `over:${l.dueOn}` : null;
    if (!stage || l.remindedFor === stage) continue;
    ctx.db.put('libraryLoans', { ...l, remindedFor: stage });
    const title = ctx.db.get('libraryBooks', l.bookId)?.title ?? 'your library book';
    await notify(ctx, 'library.due', {
      personIds: [l.personId],
      title: `${church} library: ${title}`,
      body: stage.startsWith('due') ? `"${title}" is due back tomorrow. Please bring it to the church office, or ask for more time.` : `"${title}" was due back on ${l.dueOn}. Please return it when you can so someone else can read it.`,
      link: '/app/library',
    });
  }
}

export function registerLibrary(r: Router) {
  r.get('/admin/library', { perm: 'people.view' }, (ctx) => hub(ctx));

  r.patch('/admin/library/settings', { perm: 'people.edit' }, (ctx) => {
    const n = Math.round(Number(ctx.body.loanDays));
    if (!(n >= 1 && n <= 120)) throw new ApiError(422, 'invalid', 'Lend for 1 to 120 days.', { loanDays: '1 to 120' });
    ctx.db.put('meta', { id: 'library:loanDays', value: String(n) });
    return hub(ctx);
  });

  r.post('/admin/library/books', { perm: 'people.edit' }, (ctx) => {
    // One book, or many at once from pasted lines ("Title | Author | copies").
    const lines = Array.isArray(ctx.body.books) ? (ctx.body.books as Record<string, unknown>[]).slice(0, 500) : [ctx.body as Record<string, unknown>];
    let added = 0;
    for (const b of lines) { ctx.db.put('libraryBooks', { id: ctx.id('bk'), ...readBook(b), addedAt: ctx.now.toISOString() }); added++; }
    ctx.audit('created', 'library', '', `Added ${added} book${added === 1 ? '' : 's'} to the library`);
    return hub(ctx);
  });

  r.patch('/admin/library/books/:id', { perm: 'people.edit' }, (ctx) => {
    const b = find(ctx, 'libraryBooks', ctx.params[0], 'Book');
    ctx.db.put('libraryBooks', { ...b, ...readBook(ctx.body as Record<string, unknown>, b) });
    return hub(ctx);
  });

  r.del('/admin/library/books/:id', { perm: 'people.edit' }, (ctx) => {
    const b = find(ctx, 'libraryBooks', ctx.params[0], 'Book');
    if (loansOf(ctx, b.id).some((l) => l.status === 'out')) throw new ApiError(409, 'on_loan', 'A copy is still out. Mark it returned first.');
    for (const l of loansOf(ctx, b.id)) ctx.db.del('libraryLoans', l.id);
    ctx.db.del('libraryBooks', b.id);
    return hub(ctx);
  });

  r.post('/admin/library/loans', { perm: 'people.edit' }, (ctx) => {
    const book = find(ctx, 'libraryBooks', String(ctx.body.bookId ?? ''), 'Book');
    const personId = String(ctx.body.personId ?? '');
    find(ctx, 'people', personId, 'Person');
    const waiting = loansOf(ctx, book.id).find((l) => l.personId === personId && l.status === 'requested');
    lend(ctx, book, personId, waiting);
    return hub(ctx);
  });

  r.post('/admin/library/loans/:id/:action', { perm: 'people.edit' }, async (ctx) => {
    const l = find(ctx, 'libraryLoans', ctx.params[0], 'Loan');
    const action = ctx.params[1];
    const today = localDate(ctx, ctx.now);
    if (action === 'issue') {
      if (l.status !== 'requested') throw new ApiError(409, 'invalid', 'Only a request can be handed over.');
      lend(ctx, find(ctx, 'libraryBooks', l.bookId, 'Book'), l.personId, l);
    } else if (action === 'ready') {
      // The book is set aside: tell the member it is waiting at the office.
      const b = find(ctx, 'libraryBooks', l.bookId, 'Book');
      await notify(ctx, 'library.request', { personIds: [l.personId], title: `${settings(ctx).name} library`, body: `"${b.title}" is ready for you at the church office.`, link: '/app/library' });
    } else if (action === 'return') {
      if (l.status !== 'out') throw new ApiError(409, 'invalid', 'That book is not out.');
      ctx.db.put('libraryLoans', { ...l, status: 'returned', returnedOn: today });
    } else if (action === 'renew') {
      if (l.status !== 'out') throw new ApiError(409, 'invalid', 'That book is not out.');
      const from = l.dueOn && l.dueOn > today ? l.dueOn : today;
      ctx.db.put('libraryLoans', { ...l, dueOn: addDays(from, loanDays(ctx)), remindedFor: null });
    } else if (action === 'cancel') {
      if (l.status !== 'requested') throw new ApiError(409, 'invalid', 'Only a request can be declined.');
      ctx.db.put('libraryLoans', { ...l, status: 'cancelled' });
    } else throw new ApiError(404, 'not_found', 'Unknown action.');
    return hub(ctx);
  });

  r.get('/me/library', {}, (ctx) => mine(ctx));
  r.post('/me/library/:id/request', {}, async (ctx) => {
    const b = find(ctx, 'libraryBooks', ctx.params[0], 'Book');
    const me = ctx.me();
    if (loansOf(ctx, b.id).some((l) => l.personId === me && (l.status === 'requested' || l.status === 'out'))) return mine(ctx);
    if (ctx.db.all('libraryLoans').filter((l) => l.personId === me && (l.status === 'requested' || l.status === 'out')).length >= 5) throw new ApiError(409, 'limit', 'You can have up to 5 books out or asked for at a time.');
    ctx.db.put('libraryLoans', { id: ctx.id('ln'), bookId: b.id, personId: me, status: 'requested', requestedAt: ctx.now.toISOString(), borrowedOn: null, dueOn: null, returnedOn: null, remindedFor: null, via: 'app' });
    const p = ctx.db.get('people', me);
    await notify(ctx, 'library.request', { personIds: keeperIds(ctx), except: me, title: 'Library request', body: `${p ? fullName(p) : 'A member'} would like to borrow "${b.title}".`, link: '/admin/library' });
    return mine(ctx);
  });
  r.del('/me/library/:id/request', {}, (ctx) => {
    const l = ctx.db.all('libraryLoans').find((x) => x.bookId === ctx.params[0] && x.personId === ctx.me() && x.status === 'requested');
    if (l) ctx.db.put('libraryLoans', { ...l, status: 'cancelled' });
    return mine(ctx);
  });
}
