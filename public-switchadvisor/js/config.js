// The one thing to edit after deploying the PHP backend: where it lives.
// Everything else in this app reads from here rather than hardcoding a URL.
export const API_BASE = 'https://georgewhiteeuropean.co.uk/switchadvisor.php';

// Referral links. Put your own codes in; anything still containing
// PUT-YOUR-CODE-HERE is treated as not set up and simply isn't shown. The plan
// and the Referral links tab both read from here.
export const REFERRALS = {
  topcashback: { name: 'TopCashback', url: 'https://www.topcashback.co.uk/ref/PUT-YOUR-CODE-HERE', site: 'https://www.topcashback.co.uk/', note: 'Cashback on everyday spending — sign up free.' },
  quidco: { name: 'Quidco', url: 'https://www.quidco.com/raf/PUT-YOUR-CODE-HERE', site: 'https://www.quidco.com/', note: 'Another cashback network — worth comparing a specific offer against TopCashback before clicking either.' },
  krak: { name: 'Krak', url: 'https://krak.app/@TheFlash', site: 'https://support.krak.app/articles/krak-salary-match', note: 'The Kraken app account that pays Salary Match — see the plan for the actual reward estimate.' },
};
export const isSetUp = (url) => !!url && !url.includes('PUT-YOUR-CODE-HERE');