// /utils/contextLock.js
// KORRIGERAD VERSION (v1.4)
// Fixar buggen där Area låg kvar när man bytte City.

module.exports = {
  /**
   * Lockar stad: väljer rätt stad mellan savedCity och explicitCity
   */
  resolveCity({ savedCity, explicitCity }) {
    if (explicitCity && typeof explicitCity === "string") {
      return explicitCity;
    }
    if (savedCity && typeof savedCity === "string") {
      return savedCity;
    }
    return null;
  },

  /**
   * Lockar fordontyp:
   */
  resolveVehicle({ savedVehicle, explicitVehicle }) {
    if (explicitVehicle && typeof explicitVehicle === "string") {
      return explicitVehicle;
    }
    if (savedVehicle && typeof savedVehicle === "string") {
      return savedVehicle;
    }
    return null;
  },

  /**
   * Lockar område:
   * KRITISK FIX: Om vi byter stad, får vi inte behålla gamla områden som inte finns där.
   * Denna funktion anropas nu med vetskap om staden ändrats.
   */
  resolveArea({ savedArea, explicitArea, cityChanged }) {
    // Om användaren säger ett nytt område explicit, använd det.
    if (explicitArea && typeof explicitArea === "string") {
      return explicitArea;
    }
    
    // Om staden har ändrats, måste vi rensa sparat område (annars får vi Ullevi i Eslöv).
    if (cityChanged) {
      return null;
    }

    // Annars, behåll sparat område.
    if (savedArea && typeof savedArea === "string") {
      return savedArea;
    }
    return null;
  },

  /**
   * Returnerar den uppdaterade, låsta kontexten.
   */
  resolveContext({ savedCity, savedArea, savedVehicle }, { explicitCity, explicitArea, explicitVehicle }) {
    
    const city = this.resolveCity({ savedCity, explicitCity });
    const vehicle = this.resolveVehicle({ savedVehicle, explicitVehicle });
    
    // Kolla om staden faktiskt ändrades i detta anrop
    // (Vi jämför explicitCity mot savedCity. Om explicitCity finns och är annorlunda -> cityChanged = true)
    let cityChanged = false;
    if (explicitCity && savedCity && explicitCity.toLowerCase() !== savedCity.toLowerCase()) {
        cityChanged = true;
    } else if (explicitCity && !savedCity) {
        cityChanged = true;
    }

    const area = this.resolveArea({ savedArea, explicitArea, cityChanged });

    return { city, area, vehicle };
  }
};