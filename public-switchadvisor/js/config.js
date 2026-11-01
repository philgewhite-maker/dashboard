// The one thing to edit after deploying the PHP backend: where it lives.
// Everything else in this app reads from here rather than hardcoding a URL.
export const API_BASE = 'https://georgewhiteeuropean.co.uk/switchadvisor.php';

// Referral links. Put your own codes in; anything still containing
// PUT-YOUR-CODE-HERE is treated as not set up and simply isn't shown. The plan
// and the Referral links tab both read from here.
export const REFERRALS = {
  topcashback: { name: 'TopCashback', url: 'https://www.topcashback.co.uk/ref/phlwht99', site: 'https://www.topcashback.co.uk/', note: 'Cashback on everyday spending — sign up free.' },
  quidco: { name: 'Quidco', url: 'https://quidco.com/raf/1078842/', site: 'https://www.quidco.com/', note: 'Another cashback network — worth comparing a specific offer against TopCashback before clicking either.' },
  krak: { name: 'Krak', url: 'https://krak.app/@TheFlash', site: 'https://support.krak.app/articles/krak-salary-match', note: 'The Kraken app account that pays Salary Match — see the plan for the actual reward estimate.' },
};
export const isSetUp = (url) => !!url && !url.includes('PUT-YOUR-CODE-HERE');

// Ways of creating a live Direct Debit, offered when a plan step says an account needs
// more of them. The list is meant to grow: add an entry and it appears in the "how will
// you set it up?" choice. `url` is optional; an entry whose url still contains
// PUT-YOUR-CODE-HERE is left out until you fill it in (see "own-service" below).
//   id      short and unique -- it is stored with the person's answers
//   label   the button text
//   detail  what to actually do, in a sentence or two
//   url     optional "go and do it" link
export const DD_OPTIONS = [
  {
    id: 'bill',
    label: 'Move a bill I already pay',
    detail: 'Council tax, energy, water, broadband, mobile, TV licence, insurance: pay it from this account by Direct Debit instead of by card or from another account. Ask the company, or change it in their online account.',
  },
  {
    id: 'charity',
    label: 'Give £1+ a month to a charity',
    detail: 'Any charity will set up a regular gift by Direct Debit, and most accept as little as £1–£5 a month. Choose one you would be glad to support. Keep it live until the bonus has paid, then you can cancel it whenever you like.',
  },
  {
    id: 'provider',
    label: 'Switch a phone or broadband provider',
    detail: 'A new contract is paid by Direct Debit, and some providers pay a switching reward. Check you are not leaving a contract early.',
  },
  {
    id: 'subscription',
    label: 'Start a small subscription',
    detail: 'A magazine, a gym, a streaming service, a cloud-storage plan: anything that takes payment by Direct Debit (not by card). Cancel it once the bonus has paid if you do not want it.',
  },
  {
    id: 'own-service',
    label: 'Subscribe to my £1-a-month service',
    detail: 'A £1 a month Direct Debit through Stripe. Replace the link with your own sign-up page to make this option appear.',
    url: 'PUT-YOUR-CODE-HERE',
  },
];
