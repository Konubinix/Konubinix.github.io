// Shim pour /@automerge/automerge-repo@1.2.1/es2022/slim.mjs.
// Le shim par défaut d'esm.sh est circulairement vide ; on ré-expose
// ici ce dont les adaptateurs bundled ont besoin (NetworkAdapter + cbor).
export { NetworkAdapter } from 'https://esm.sh/@automerge/automerge-repo@1.2.1/dist/network/NetworkAdapter';
import * as cborNs from 'https://esm.sh/@automerge/automerge-repo@1.2.1/dist/helpers/cbor';
export const cbor = cborNs;
