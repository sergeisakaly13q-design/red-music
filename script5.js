
function handleMusicFiles(fileList){
  const files = Array.from(fileList || []).filter(file => {
    const type = String(file.type || "").toLowerCase();
    const name = String(file.name || "").toLowerCase();
    return type.startsWith("audio/") ||
      /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i.test(name);
  });

  if(!files.length){
    alert("Аудиофайлы не найдены.");
    return;
  }

  let added = 0;
  let skipped = 0;

  for(const file of files){
    try{
      // Keep the existing single-file importer if the project already provides it.
      if(typeof addLocalMusicFile === "function"){
        const result = addLocalMusicFile(file);
        if(result === false) skipped++;
        else added++;
      }else if(typeof addMusicFile === "function" && addMusicFile !== handleMusicFiles){
        const result = addMusicFile(file);
        if(result === false) skipped++;
        else added++;
      }else if(typeof importLocalTrack === "function"){
        const result = importLocalTrack(file);
        if(result === false) skipped++;
        else added++;
      }else{
        // Fallback: keep files in a browser-local batch for the existing app.
        if(!window.redMusicPendingLocalFiles) window.redMusicPendingLocalFiles=[];
        window.redMusicPendingLocalFiles.push(file);
        added++;
      }
    }catch(error){
      console.error("Не удалось добавить файл:", file.name, error);
      skipped++;
    }
  }

  if(typeof renderLibrary === "function") renderLibrary();
  if(typeof renderMusicLibrary === "function") renderMusicLibrary();
  if(typeof updateMusicUI === "function") updateMusicUI();

  if(added){
    console.log(`Red Music: добавлено файлов: ${added}${skipped ? `, пропущено: ${skipped}` : ""}`);
  }

  // Reset input so the same file/folder can be selected again later.
  const input = document.getElementById("redMusicFolderPicker");
  if(input) input.value="";
}
