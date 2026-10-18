// ডেমো প্রোভাইডার — আসল SMS ছাড়াই পুরো কেনা-বেচার ফ্লো টেস্ট করার জন্য।
// নম্বর কেনার ~১৫ সেকেন্ড পর ভুয়া OTP কোড "আসে"।
const SERVICES = [
  { code: 'facebook',  name: 'Facebook',          logo: 'facebook' },
  { code: 'whatsapp',  name: 'WhatsApp',          logo: 'whatsapp' },
  { code: 'telegram',  name: 'Telegram',         logo: 'telegram' },
  { code: 'tiktok',    name: 'TikTok',           logo: 'tiktok' },
  { code: 'google',    name: 'Google / Gmail',   logo: 'google' },
  { code: 'youtube',   name: 'YouTube',          logo: 'youtube' },
  { code: 'imo',       name: 'imo',              logo: 'imo' },
  { code: 'instagram', name: 'Instagram',        logo: 'instagram' },
];

const COUNTRIES = [
  { code: 'US', name: 'USA',        flag: '🇺🇸', baseUsd: 0.52, count: 2475 },
  { code: 'UK', name: 'UK',         flag: '🇬🇧', baseUsd: 0.61, count: 1830 },
  { code: 'ID', name: 'Indonesia',  flag: '🇮🇩', baseUsd: 0.18, count: 5210 },
  { code: 'BD', name: 'Bangladesh', flag: '🇧🇩', baseUsd: 0.35, count: 640 },
  { code: 'IN', name: 'India',      flag: '🇮🇳', baseUsd: 0.22, count: 3940 },
];

const activations = new Map();
let seq = 1000;
const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

module.exports = {
  name: 'mock',
  async getServices() { return SERVICES; },
  async getCountries(/* service */) { return COUNTRIES; },
  async buyNumber(service, country) {
    const id = 'm' + (++seq);
    const c = COUNTRIES.find(x => x.code === country) || COUNTRIES[0];
    activations.set(id, { number: '+' + rnd(2) + ' ' + rnd(4) + ' ' + rnd(6), service, country, createdAt: Date.now(), code: null });
    return { providerId: id, number: activations.get(id).number };
  },
  async getSms(providerId) {
    const a = activations.get(providerId);
    if (!a) return null;
    if (!a.code && Date.now() - a.createdAt > 15000) a.code = rnd(6);
    return a.code;
  },
  async cancel(providerId) { activations.delete(providerId); return true; }
};
