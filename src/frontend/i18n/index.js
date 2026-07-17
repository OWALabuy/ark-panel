import zhCN from "./zh-CN.js";
import en from "./en.js";

export const LOCALES=["zh-CN","en"];
export const LOCALE_CACHE_KEY="ark-panel:locale:v1";
const catalogs={"zh-CN":zhCN,en};
let locale=readCachedLocale();

function readCachedLocale(){try{const value=localStorage.getItem(LOCALE_CACHE_KEY);return LOCALES.includes(value)?value:"zh-CN"}catch{return"zh-CN"}}
function interpolate(template,params){return template.replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(params,key)?String(params[key]):match)}
export function getLocale(){return locale}
export function normalizeLocale(value){return LOCALES.includes(value)?value:"zh-CN"}
export function t(key,params={}){return interpolate(catalogs[locale][key]??catalogs["zh-CN"][key]??key,params)}
export function formatNumber(value){return new Intl.NumberFormat(locale).format(Number(value))}
export function formatDate(value,options){try{return new Intl.DateTimeFormat(locale,options).format(new Date(value))}catch{return""}}
export function applyStaticTranslations(root=document){
  document.documentElement.lang=locale;
  for(const element of root.querySelectorAll("[data-i18n]"))element.textContent=t(element.dataset.i18n);
  for(const element of root.querySelectorAll("[data-i18n-aria-label]"))element.setAttribute("aria-label",t(element.dataset.i18nAriaLabel));
  for(const element of root.querySelectorAll("[data-i18n-title]"))element.title=t(element.dataset.i18nTitle);
  for(const element of root.querySelectorAll("[data-i18n-placeholder]"))element.placeholder=t(element.dataset.i18nPlaceholder);
}
export function setLocale(value,{cache=true,translate=true}={}){
  locale=normalizeLocale(value);
  if(cache)try{localStorage.setItem(LOCALE_CACHE_KEY,locale)}catch{}
  if(translate)applyStaticTranslations();else document.documentElement.lang=locale;
  globalThis.dispatchEvent(new CustomEvent("panel:localechange",{detail:{locale}}));
  return locale;
}
export function catalogKeys(){return Object.keys(zhCN)}
export function catalogFor(value){return catalogs[normalizeLocale(value)]}
