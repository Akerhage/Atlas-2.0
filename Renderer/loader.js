document.addEventListener("DOMContentLoaded", () => {
    const red = document.getElementById("light-red");
    const yellow = document.getElementById("light-yellow");
    const green = document.getElementById("light-green");
    const text = document.getElementById("loader-text");

    // Rött
    setTimeout(() => {
        red.classList.add("active");
        text.textContent = "Lägg i ettans växel";
    }, 300);

    // Orange
    setTimeout(() => {
        red.classList.remove("active");
        yellow.classList.add("active");
        text.textContent = "Släpp på kopplingen";
    }, 1300);

    // Grönt + SIGNAL TILL MAIN.JS
    setTimeout(() => {
        yellow.classList.remove("active");
        green.classList.add("active");
        text.textContent = "NU KÖR VI!";
        
        // ✅ SKICKA SIGNAL EFTER 500ms (låt grönt ljus visas först)
        setTimeout(() => {
            if (window.electronAPI && window.electronAPI.loaderDone) {
                window.electronAPI.loaderDone();
                console.log('[LOADER] Signal skickad till main.js');
            }
        }, 500);
    }, 2300);
});