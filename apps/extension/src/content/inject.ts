(() => {
  try {
    const player = document.querySelector('#movie_player') as any;
    return player && typeof player.getPlayerResponse === 'function' 
      ? player.getPlayerResponse() 
      : (window as any).ytInitialPlayerResponse;
  } catch (e) {
    return null;
  }
})();
