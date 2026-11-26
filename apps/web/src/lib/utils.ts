import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export { isSafeHttpsUrl } from '@forgeflow/shared-types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
