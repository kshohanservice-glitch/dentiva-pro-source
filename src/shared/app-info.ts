/**
 * Product identity and build metadata.
 * Kept free of Node/Electron imports so it can be consumed by the renderer, the
 * main process and build tooling alike.
 */
export const APP_ID = 'com.dentivapro.desktop';
export const APP_NAME = 'Dentiva Pro';
export const APP_SHORT_NAME = 'Dentiva';
export const APP_VERSION = '1.0.0';
export const APP_BUILD_NUMBER = '1000';
export const APP_COUNTRY = 'Bangladesh';
export const APP_CURRENCY_CODE = 'BDT';
export const APP_CURRENCY_SYMBOL = '\u09F3';
export const APP_AUTHOR_NAME = 'Shohan Khan';
export const APP_AUTHOR_EMAIL = 'helloiamshohan@gmail.com';
export const APP_COPYRIGHT = `Copyright (c) ${new Date().getFullYear()} Shohan Khan. All rights reserved.`;
export const APP_TAGLINE = 'Offline dental practice management for Bangladesh';

/** Default in-product locale settings; clinics can override them in Settings. */
export const DEFAULT_TIME_ZONE = 'Asia/Dhaka';
export const DEFAULT_DATE_FORMAT = 'DD MMM YYYY';
export const DEFAULT_TIME_FORMAT = 'hh:mm A';
export const BENGALI_LANGUAGE_TAG = 'bn-BD';
