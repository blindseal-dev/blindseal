// window.BS is populated by the kit JS (src/kit/*.js). The kit is JS; we treat BS as `any`.
declare global {
  interface Window {
    BS: any;
    BS_NOW?: number;
  }
}
declare module '*.js';
export {};
