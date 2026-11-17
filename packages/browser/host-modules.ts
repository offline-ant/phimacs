// First manifest entry, left as TypeScript so Pi's jiti loader transpiles it and
// hands it Pi's own SDK; the compiled extension after it then shares that SDK.
import * as ai from "@earendil-works/pi-ai";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as typebox from "typebox";
import { shareHostModules } from "@phimacs/pimux/host-modules";

export default function hostModules(): void {
  shareHostModules({
    "@earendil-works/pi-ai": ai,
    "@earendil-works/pi-coding-agent": codingAgent,
    typebox,
  });
}
