// Loader registration entry: `node --import ./register.mjs <test>`
import { register } from "node:module";

register("./loader-resolve.mjs", import.meta.url);
