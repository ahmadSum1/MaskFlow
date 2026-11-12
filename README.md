# MaskFlow

MaskFlow is a browser-based viewer for images, NumPy arrays, segmentation masks, and saliency maps. Files are read and processed locally in your browser; they are not sent to a server. No Python installation, build step, or backend is needed.

## Run locally

From the repository root, serve the files with any static web server. For example, if Python is installed:

```sh
python3 -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000). Python is only needed for this example server, not by the app. Use a server rather than opening `index.html` directly, since the app loads JavaScript modules, workers, and samples over HTTP.

## Host on GitHub Pages

1. Create a GitHub repository or fork this one. Commit and push the app to the branch you want to publish. The repository root must contain `index.html`, `styles.css`, and the `src/` directory. Include `sample/set1_pngpng/im00.png`, `gt00.png`, `im01.png`, and `gt01.png` to enable **Load samples**. Do not commit private datasets.
2. On GitHub, open the repository's **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**. Select the branch you pushed and **/(root)**, then click **Save**.
4. Wait for the deployment to finish. The Pages settings will show the site URL. For this repository, the expected URL is `https://ahmadsum1.github.io/MaskFlow/` once Pages is enabled and deployed; for a fork, use the URL shown in its settings.

Push changes to the selected branch to update the site. No build step, backend, or installed dependencies are required. If the site is unavailable, check the deployment status in the repository's **Actions** tab and confirm that GitHub Pages is available for the repository's visibility and plan.

GitHub Pages serves the app over HTTPS, enabling browser features that require a secure context. Selected local files are processed in the browser, not uploaded to the host. Once the app is loaded, viewing your own files does not require internet access; loading bundled samples requires access to the host unless they are cached.

## Use

Choose **Load folder** or **Load files**, or drag files or folders onto the canvas. Browsers do not permit websites to read an arbitrary local directory path: select a folder in the browser's picker instead. Folder picking and folder drag-and-drop depend on browser support (current Chromium-based browsers are recommended). These actions replace the current dataset.

Use **Add folder → Add dataset folder** to retain the current items and add another dataset, or **Add folder → Add masks folder** to treat supported files in a folder as masks or predictions, including files without a mask suffix. The masks dialog offers the existing automatic matching across all loaded bases or lets you select a base folder and matching rule before choosing the new masks folder. Existing masks and edits remain in place. Previously orphaned masks can also match bases from a later dataset folder. Adding the same folder again can create duplicates.

Open **Advanced → Match loaded folders** and drag paths from the middle list into the base and mask columns, or use the arrow buttons. Add multiple base paths, then select each base to assign its own mask paths and matching rule. Paths include subfolders; the same path can be assigned to both sides or shared between groups. Multiple masks can match one base, and a mask can match bases in different groups; existing pairs are not reassigned. Automatic matching uses the usual name keys. **Numeric ID** matches names such as `P1_8192x4096.jpg` and `HEsalmap_1.png`, ignoring resolution. To learn a pattern, choose an example base and mask from the assigned paths and select their shared numeric or alphabetic ID; search to narrow the file lists. The generated expressions generalize the ID and numeric suffixes, so review the preview before applying. For other conventions, remove literal prefixes and suffixes from each filename stem, or provide a regular expression for each side whose first capture group is the shared ID. Matching is case-insensitive; files matching both roles in overlapping paths, or with multiple possible bases within a group, are not guessed. Preview reports each group's proposals and unmatched candidates without modifying the dataset; the total deduplicates identical proposals.

Example-based matching uses already-loaded files. To learn from a new mask folder, first load it with **Add dataset folder**, then use **Match loaded folders**. A shared ID must appear as a distinct numeric or alphabetic filename token in both examples; use a custom expression when that is not sufficient.

Use **Advanced → Remove folders** to remove files directly in one or more loaded paths from the viewer. Select **Include subfolders** to remove their descendants too. Files from other paths remain available: a surviving base becomes single if all its masks were removed, and surviving masks become orphans if their base was removed. Folder labels include the load number so similarly named folders loaded separately remain distinct. These operations never change files on disk.

Open the **i** help menu in the header and select **Load samples** to explore the two bundled image/ground-truth pairs (`im00.png` / `gt00.png` and `im01.png` / `gt01.png`). This replaces the current dataset. The four files in `sample/set1_pngpng/` must be included when publishing the site; samples are fetched from the same host as the app, while your selected files are never sent to the server.

Use **Clear dataset** to unload all files and return to the empty viewer; this does not delete or modify local files. On wider screens, drag the divider on the right edge of the dataset panel to resize it. You can also focus the divider and use the arrow keys, Home, or End. On narrow screens the panel is stacked above the viewer instead.

Large datasets are enumerated and indexed in a background worker; only the selected image and mask are read and decoded. On supported browsers in a secure context, folder selection uses the File System Access API and shows a loading indicator and file count while the worker scans; file handles are opened only when needed. File and folder selection controls are disabled during selection or loading to prevent multiple dialogs. The VS Code integrated browser uses the folder input instead because its directory picker can remain active indefinitely. Other browsers without the File System Access API also use the folder input; its initial enumeration is controlled by the browser and may temporarily block the page or animation. For very large folders, especially across Windows and WSL, use a regular Chromium-based browser with the File System Access API when possible. File size and modified-time sorts read metadata on demand in a worker; dimension sorting reads headers on demand. The sidebar renders a small window of items as you scroll. Focus the list and use Up/Down, Page Up/Down, Home, or End to navigate it by keyboard. **Clear dataset** cancels ongoing indexing or view updates.

If the picker has closed but MaskFlow is still waiting for a selection, use **Stop waiting** to restore the controls, or **Try alternative folder picker** to use the browser's folder input instead. These controls do not close an open system dialog. If the browser reports that a picker is still active, reload the page or use a regular browser rather than an embedded browser.

MaskFlow pairs files by name, ignoring case. Image files can pair with same-name `.npy` files, and images or arrays pair with masks bearing a `mask`, `masks`, `gt`, `groundtruth`, `ground_truth`, `seg`, `segmentation`, `label`, or `labels` prefix or suffix separated by `_`, `-`, `.`, or a space. Files inside folders named `mask`, `masks`, `map`, `maps`, `gt`, `groundtruth`, `ground_truth`, `segmentation`, `label`, or `labels` are also treated as masks, allowing layouts such as `images/train/frame.jpg` + `maps/train/frame.png`. The nearest recognized image or mask folder determines the role when these names are nested. Numeric names such as `im00.png` + `gt00.png` are also recognized. Other examples: `frame_001.jpg` + `frame_001_mask.npy`, `image.png` + `image.npy`, and `gt_frame_002.npy` + `frame_002.png`. Matching files in the same folder take precedence; cross-folder matches are made only when the base is unambiguous. Unpaired files remain accessible as standalone entries.

Choose an entry from the sidebar or use the arrow buttons or left/right arrow keys. Adjust overlay opacity and colormap in Display settings. Masks are stretched to the base dimensions if they differ; this is a visual resize, not image registration. Image masks are mapped by luminance. Scalar arrays are normalized to their finite minimum and maximum before applying the colormap; a constant zero array maps to the low end and any other constant array to the high end. Non-finite values map to the low end. RGB(A) arrays used as masks are converted to their average channel value before coloring. Colormaps are interpolated approximations of the named palettes.

Enter a 1-based item number between the navigation arrows to jump directly within the current filtered view. The dataset panel can filter by pair status (paired, single base, or orphan mask) and sort by path, name, file size, pixel area, or last-modified time. Use the up/down arrows to change sort order and the switches to enable pair-status grouping and tree view independently. Size, dimensions, and time refer to the base file. Tree view displays the base file's folder hierarchy; sorting applies within each folder and status group. Collapse or expand folders using their buttons; navigation still includes collapsed items and expands their folders when selected.

Dimension sorting reads file headers on demand in a background worker and caches the results for the current dataset. It supports PNG, JPEG, GIF, BMP, WebP, and supported NPY shapes; AVIF and unreadable headers have unknown dimensions and sort last. JPEG and NPY header reads are limited to 1 MiB. The panel reports unknown values rather than decoding the entire dataset.

Use **Add mask** to attach a missing mask or add another prediction/ground truth to the current base, and **Replace mask** to update the selected mask. Expand the arrow beside a base in the sidebar to select its masks, or use the **Mask / ground truth** selector. Each base/mask pair remains a separate navigation item, even when its masks are collapsed. **Swap front / back** reverses the layer order without changing their colors or filenames. The opacity slider controls whichever layer is in front. Changes are kept while navigating the current dataset, but are not written to your files and are discarded when a new dataset is opened or the page is refreshed.

Right-click a base or expanded mask to copy its file name or, when available, its path relative to the selected or dropped folder. Individually selected files do not provide a folder path. Clipboard access requires a secure context (HTTPS or localhost) and browser permission. Browsers do not expose absolute local paths or allow a web page to open the containing folder in the system file explorer.

## Supported data

- Images: PNG, JPEG, WebP, BMP, GIF, and AVIF when supported by the browser. Animated images display their decoded frame.
- NumPy `.npy` versions 1, 2, and 3: 2D `(height, width)` arrays, channel-last `(height, width, 1|3|4)` arrays, or channel-first `(1|3|4, height, width)` arrays. When both first and last dimensions could be channels, channel-last takes precedence. Both C and Fortran order, little- and big-endian numeric data, booleans, integers, and float16/32/64 are supported. RGB(A) base arrays are displayed as color images. Object, structured, complex, compressed `.npz`, and higher-dimensional arrays are not supported. Large arrays are limited by browser memory and canvas limits.

Errors, including unsupported or malformed arrays, are shown in the viewer. Files with other extensions are skipped. Data is processed with browser Canvas and JavaScript; canvas compositing may use browser hardware acceleration, but GPU acceleration is not required.

## Development

Run the dependency-free tests with Node.js:

```sh
npm test
```
