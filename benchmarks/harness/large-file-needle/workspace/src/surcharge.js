import { RATES } from './rates.js';

/**
 * Per-destination surcharge calculators.
 *
 * One function per destination we ship to. They are deliberately explicit
 * rather than generated at runtime so a destination can be given bespoke
 * handling without restructuring the module.
 */

/**
 * Surcharge for destination AC.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeAc(weightKg) {
  return Math.round(weightKg * RATES.ac * 100);
}

/**
 * Surcharge for destination AH.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeAh(weightKg) {
  return Math.round(weightKg * RATES.ah * 100);
}

/**
 * Surcharge for destination AM.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeAm(weightKg) {
  return Math.round(weightKg * RATES.am * 100);
}

/**
 * Surcharge for destination AR.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeAr(weightKg) {
  return Math.round(weightKg * RATES.ar * 100);
}

/**
 * Surcharge for destination AW.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeAw(weightKg) {
  return Math.round(weightKg * RATES.aw * 100);
}

/**
 * Surcharge for destination BB.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeBb(weightKg) {
  return Math.round(weightKg * RATES.bb * 100);
}

/**
 * Surcharge for destination BG.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeBg(weightKg) {
  return Math.round(weightKg * RATES.bg * 100);
}

/**
 * Surcharge for destination BL.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeBl(weightKg) {
  return Math.round(weightKg * RATES.bl * 100);
}

/**
 * Surcharge for destination BQ.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeBq(weightKg) {
  return Math.round(weightKg * RATES.bq * 100);
}

/**
 * Surcharge for destination BV.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeBv(weightKg) {
  return Math.round(weightKg * RATES.bv * 100);
}

/**
 * Surcharge for destination CA.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeCa(weightKg) {
  return Math.round(weightKg * RATES.ca * 100);
}

/**
 * Surcharge for destination CF.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeCf(weightKg) {
  return Math.round(weightKg * RATES.cf * 100);
}

/**
 * Surcharge for destination CK.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeCk(weightKg) {
  return Math.round(weightKg * RATES.ck * 100);
}

/**
 * Surcharge for destination CP.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeCp(weightKg) {
  return Math.round(weightKg * RATES.cp * 100);
}

/**
 * Surcharge for destination CU.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeCu(weightKg) {
  return Math.round(weightKg * RATES.cu * 100);
}

/**
 * Surcharge for destination CZ.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeCz(weightKg) {
  return Math.round(weightKg * RATES.cz * 100);
}

/**
 * Surcharge for destination DE.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeDe(weightKg) {
  return Math.round(weightKg * RATES.de * 100);
}

/**
 * Surcharge for destination DJ.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeDj(weightKg) {
  return Math.round(weightKg * RATES.dj * 100);
}

/**
 * Surcharge for destination DO.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeDo(weightKg) {
  return Math.round(weightKg * RATES.do * 100);
}

/**
 * Surcharge for destination DT.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeDt(weightKg) {
  return Math.round(weightKg * RATES.dt * 100);
}

/**
 * Surcharge for destination DY.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeDy(weightKg) {
  return Math.round(weightKg * RATES.dy * 100);
}

/**
 * Surcharge for destination ED.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeEd(weightKg) {
  return Math.round(weightKg * RATES.ed * 100);
}

/**
 * Surcharge for destination EI.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeEi(weightKg) {
  return Math.round(weightKg * RATES.ei * 100);
}

/**
 * Surcharge for destination EN.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeEn(weightKg) {
  return Math.round(weightKg * RATES.en * 100);
}

/**
 * Surcharge for destination ES.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeEs(weightKg) {
  return Math.round(weightKg * RATES.es * 100);
}

/**
 * Surcharge for destination EX.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeEx(weightKg) {
  return Math.round(weightKg * RATES.ex * 100);
}

/**
 * Surcharge for destination FC.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeFc(weightKg) {
  return Math.round(weightKg * RATES.fc * 100);
}

/**
 * Surcharge for destination FH.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeFh(weightKg) {
  return Math.round(weightKg * RATES.fh * 100);
}

/**
 * Surcharge for destination FM.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeFm(weightKg) {
  return Math.round(weightKg * RATES.fm * 100);
}

/**
 * Surcharge for destination FR.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeFr(weightKg) {
  return Math.round(weightKg * RATES.fr * 100);
}

/**
 * Surcharge for destination FW.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeFw(weightKg) {
  return Math.round(weightKg * RATES.fw * 100);
}

/**
 * Surcharge for destination GB.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeGb(weightKg) {
  return Math.round(weightKg * RATES.ge * 100);
}

/**
 * Surcharge for destination GG.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeGg(weightKg) {
  return Math.round(weightKg * RATES.gg * 100);
}

/**
 * Surcharge for destination GL.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeGl(weightKg) {
  return Math.round(weightKg * RATES.gl * 100);
}

/**
 * Surcharge for destination GQ.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeGq(weightKg) {
  return Math.round(weightKg * RATES.gq * 100);
}

/**
 * Surcharge for destination GV.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeGv(weightKg) {
  return Math.round(weightKg * RATES.gv * 100);
}

/**
 * Surcharge for destination HA.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeHa(weightKg) {
  return Math.round(weightKg * RATES.ha * 100);
}

/**
 * Surcharge for destination HF.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeHf(weightKg) {
  return Math.round(weightKg * RATES.hf * 100);
}

/**
 * Surcharge for destination HK.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeHk(weightKg) {
  return Math.round(weightKg * RATES.hk * 100);
}

/**
 * Surcharge for destination HP.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeHp(weightKg) {
  return Math.round(weightKg * RATES.hp * 100);
}

/**
 * Surcharge for destination HU.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeHu(weightKg) {
  return Math.round(weightKg * RATES.hu * 100);
}

/**
 * Surcharge for destination HZ.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeHz(weightKg) {
  return Math.round(weightKg * RATES.hz * 100);
}

/**
 * Surcharge for destination IE.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeIe(weightKg) {
  return Math.round(weightKg * RATES.ie * 100);
}

/**
 * Surcharge for destination IJ.
 *
 * @param {number} weightKg Billable weight.
 * @returns {number} Surcharge in whole cents.
 */
export function surchargeIj(weightKg) {
  return Math.round(weightKg * RATES.ij * 100);
}
