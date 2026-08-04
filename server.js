function checkWin(hand) {
    if (!hand || hand.length !== 5) return 0;
    const counts = {};
    hand.forEach(t => counts[t] = (counts[t] || 0) + 1);

    const hasSubset = (subset) => {
        let temp = { ...counts };
        for (let t of subset) {
            if (!temp[t] || temp[t] <= 0) return false;
            temp[t]--;
        }
        return true;
    };

    const checkPairInRemaining = (subset) => {
        let temp = { ...counts };
        for (let t of subset) temp[t]--;
        let rem = [];
        for (let t in temp) {
            for (let i = 0; i < temp[t]; i++) rem.push(t);
        }
        return rem.length === 2 && rem[0] === rem[1];
    };

    // ③ 兵兵兵兵兵 或 卒卒卒卒卒 (=10分)
    if (counts['兵'] === 5 || counts['卒'] === 5) return 10;

    // ⑤ 帥+將+兵兵兵 或 卒卒卒 (=8分)
    if (hasSubset(['帥', '將', '兵', '兵', '兵']) || hasSubset(['帥', '將', '卒', '卒', '卒'])) return 8;

    // ④ 除了將/帥以外：任意兩張相同棋子 + 兵兵兵 或 卒卒卒 (=5分)
    // 支援紅黑跨色搭配 (例如：相相 + 卒卒卒)
    const validPairs = ['仕', '相', '俥', '傌', '炮', '士', '象', '車', '馬', '包'];
    if (counts['兵'] === 3 || counts['卒'] === 3) {
        let pawnTile = counts['兵'] === 3 ? '兵' : '卒';
        let temp = { ...counts };
        temp[pawnTile] -= 3;
        for (let t in temp) {
            if (temp[t] === 2 && validPairs.includes(t)) return 5;
        }
    }

    // ① 帥仕相 / 將士象 + 對子 (=3分)
    if (hasSubset(['帥', '仕', '相']) && checkPairInRemaining(['帥', '仕', '相'])) return 3;
    if (hasSubset(['將', '士', '象']) && checkPairInRemaining(['將', '士', '象'])) return 3;

    // ② 俥傌炮 / 車馬包 + 對子 (=3分)
    if (hasSubset(['俥', '傌', '炮']) && checkPairInRemaining(['俥', '傌', '炮'])) return 3;
    if (hasSubset(['車', '馬', '包']) && checkPairInRemaining(['車', '馬', '包'])) return 3;

    return 0;
}