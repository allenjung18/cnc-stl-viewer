/**
 * Web Worker shell: parses one STL off the main thread. A 200 MB file takes
 * seconds to parse; the page stays responsive meanwhile.
 */
import { handleParseRequest, type ParseRequest } from './parse';

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  handleParseRequest(event.data, (msg, transfer) => self.postMessage(msg, { transfer }));
};
