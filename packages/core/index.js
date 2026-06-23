/* @cardsnap/core — 共用商業邏輯的 npm / React Native 入口
   真實來源在 ../../assets/core.js(同一份 UMD;Web 以 <script> 直接載入)。
   此處僅作為 package 邊界,轉出同一組 API,讓 RN/Node/打包工具可 import。
   未來若要發佈成獨立 npm 套件,把 core 程式碼搬進本檔即可(見 README)。 */
module.exports = require('../../assets/core.js');
