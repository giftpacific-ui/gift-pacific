import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function toBengaliNum(num: number | string): string {
  const bengaliDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(num).replace(/\d/g, (d) => bengaliDigits[Number(d)]);
}

export function formatPrice(amount: number): string {
  const formatted = amount.toLocaleString('en-IN');
  return `৳ ${toBengaliNum(formatted)}`;
}

export function getDeviceInfo(): string {
  if (typeof window === 'undefined' || !navigator) return 'Web Client';
  const ua = navigator.userAgent;
  let device = 'Web Browser';

  const samsungMatch = ua.match(/SM-[A-Z0-9]+|SCH-[A-Z0-9]+|SGH-[A-Z0-9]+|GT-[A-Z0-9]+/i);
  if (samsungMatch) device = 'Samsung ' + samsungMatch[0];
  else if (/iPhone/i.test(ua)) device = 'Apple iPhone';
  else if (/iPad/i.test(ua)) device = 'Apple iPad';
  else if (/Mi\s|Redmi/i.test(ua)) {
    const match = ua.match(/Mi\s(\w)+|Redmi\s(\w)+/);
    device = 'Xiaomi ' + (match ? match[0] : 'Redmi');
  } else if (/vivo/i.test(ua)) {
    const match = ua.match(/vivo\s(\w)+/i);
    device = 'Vivo ' + (match ? match[0] : 'Vivo');
  } else if (/OPPO/i.test(ua)) {
    const match = ua.match(/OPPO\s(\w)+/i);
    device = 'Oppo ' + (match ? match[0] : 'Oppo');
  } else if (/Realme/i.test(ua)) {
    const match = ua.match(/Realme\s(\w)+/i);
    device = 'Realme ' + (match ? match[0] : 'Realme');
  } else if (/Huawei/i.test(ua)) device = 'Huawei';
  else if (/Windows/i.test(ua)) device = 'Windows Desktop';
  else if (/Macintosh/i.test(ua)) device = 'Apple Mac';
  else if (/Android/i.test(ua)) device = 'Android Device';
  else if (/Linux/i.test(ua)) device = 'Linux Desktop';

  return device;
}
