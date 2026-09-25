// Both the ZIP transport and directory export consume the same file list.
export async function writeReportFolder(parent, baseName, files) {
  if (!baseName || /[\\/:]|^\.{1,2}$/.test(baseName)) throw new Error('結果フォルダ名が不正です');
  for (const file of files) {
    if (!file.name || file.name.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
      throw new Error('レポート内のファイル名が不正です');
    }
  }
  let name = baseName;
  for (let number = 1; ; number++) {
    name = number === 1 ? baseName : `${baseName} (${number})`;
    try { await parent.getDirectoryHandle(name); }
    catch (error) {
      if (error.name === 'NotFoundError') break;
      if (error.name !== 'TypeMismatchError') throw error;
    }
  }
  const directory = await parent.getDirectoryHandle(name, { create: true });
  try {
    for (const file of files) {
      const parts = file.name.split('/');
      let folder = directory;
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
      const handle = await folder.getFileHandle(parts.at(-1), { create: true });
      const stream = await handle.createWritable();
      try { await stream.write(file.bytes); await stream.close(); }
      catch (error) { try { await stream.abort(); } catch {} throw error; }
    }
    return name;
  } catch (error) {
    try { await parent.removeEntry(name, { recursive: true }); }
    catch (cleanupError) { throw new Error(`保存に失敗し、作成途中の「${name}」を削除できませんでした。フォルダを確認してください。`, { cause: cleanupError }); }
    throw error;
  }
}
