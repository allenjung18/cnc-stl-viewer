/**
 * Whole-window drag-and-drop, plus a file-picker fallback. Hands the first file
 * on; whether it is an STL is for the sniffer to say, not the file name.
 */

export interface DropzoneOptions {
  /** Where drops land; the whole window in the app. */
  readonly target: EventTarget;
  /** Shown while a file is dragged over the target. */
  readonly overlay: HTMLElement;
  /** The hidden `<input type="file">` behind the "Open" button. */
  readonly input: HTMLInputElement;
  /** Opens the file picker. */
  readonly button: HTMLElement;
  readonly onFile: (file: File) => void;
  /** A drop that held no file (text, a link). */
  readonly onReject: (message: string) => void;
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/** Installs the listeners; the returned function removes them. */
export function installDropzone(options: DropzoneOptions): () => void {
  const { target, overlay, input, button, onFile, onReject } = options;
  let depth = 0;
  const show = (on: boolean): void => {
    overlay.hidden = !on;
  };

  const onDragEnter = (e: Event): void => {
    const event = e as DragEvent;
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth++;
    show(true);
  };
  const onDragOver = (e: Event): void => {
    const event = e as DragEvent;
    if (!carriesFiles(event)) return;
    event.preventDefault(); // without this the browser opens the file itself
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: Event): void => {
    if (!carriesFiles(e as DragEvent)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  };
  const onDrop = (e: Event): void => {
    const event = e as DragEvent;
    event.preventDefault();
    depth = 0;
    show(false);
    const file = event.dataTransfer?.files[0];
    if (file) onFile(file);
    else onReject('Drop an STL file to load it.');
  };
  const onPick = (): void => {
    const file = input.files?.[0];
    if (file) onFile(file);
    input.value = ''; // picking the same file again still fires `change`
  };

  const onButton = (): void => input.click();

  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);
  input.addEventListener('change', onPick);
  button.addEventListener('click', onButton);
  return () => {
    target.removeEventListener('dragenter', onDragEnter);
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop', onDrop);
    input.removeEventListener('change', onPick);
    button.removeEventListener('click', onButton);
  };
}
