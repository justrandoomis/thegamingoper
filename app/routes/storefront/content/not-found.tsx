import { data } from "react-router";

/** Catch-all: any storefront path that matches no route renders the layout's error boundary with a real 404 status. */
export function loader() {
  throw data({ error: "not_found" }, { status: 404 });
}

export default function NotFound() {
  return null;
}
