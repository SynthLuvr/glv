import type { ComponentChild, HTMLAttributes } from "preact";
import { Fragment } from "preact";

// The JSX layer for server-rendered markup: views are pure synchronous
// components rendered to strings. Child and PropsWithChildren are the
// prop-shape aliases the views were written against.
type Child = ComponentChild;

type PropsWithChildren<P = Record<string, never>> = P & {
  children?: Child;
};

// @github/auto-complete-element's custom element, used by the schedule
// form's timezone combobox; typed here so JSX accepts it.
declare module "preact" {
  // biome-ignore lint/style/noNamespace: preact's JSX.IntrinsicElements augmentation can only be declared through a namespace.
  namespace JSX {
    interface IntrinsicElements {
      "auto-complete": HTMLAttributes<HTMLElement> & {
        src?: string;
        for?: string;
        "fetch-on-empty"?: boolean | string;
      };
    }
  }
}

export type { Child, PropsWithChildren };
export { Fragment };
