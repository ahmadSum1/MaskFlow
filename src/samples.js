const SAMPLE_FILES = ['im00.png', 'gt00.png', 'im01.png', 'gt01.png'];
const SAMPLE_DIRECTORY = new URL('../sample/set1_pngpng/', import.meta.url);

export async function loadSampleFiles() {
  return Promise.all(SAMPLE_FILES.map(async name => {
    const response = await fetch(new URL(name, SAMPLE_DIRECTORY));
    if (!response.ok) throw new Error(`Could not fetch ${name} (HTTP ${response.status}).`);
    return new File([await response.blob()], name, { type: response.headers.get('content-type') || '' });
  }));
}
