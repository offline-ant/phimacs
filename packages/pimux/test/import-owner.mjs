// Exercise the owner's actual compiled import graph without starting a runtime.
import { ownRuntime } from "../dist/runtime-owner.js";

console.log(typeof ownRuntime);
