const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 設定靜態檔案資料夾 (對應你的 public 資料夾)
app.use(express.static('public'));

// 遊戲房間狀態管理
const rooms = {};

// 生成 32 張標準象棋牌庫
function generateDeck() {
    const pieces = [
        '帥', '仕', '仕', '相', '相', '俥', '俥', '傌', '傌', '炮', '炮', '兵', '兵', '兵', '兵', '兵',
        '將', '士', '士', '象', '象', '車', '車', '馬', '馬', '包', '包', '卒', '卒', '卒', '卒', '卒'
    ];
    // 洗牌演算法 (Fisher-Yates)
    for (let i = pieces.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
    }
    return pieces;
}

/**
 * 核心：胡牌條件判斷邏輯
 * @param {Array} hand - 玩家手牌 (必須剛好是 5 張，包含剛摸到的或別人的棄牌)
 * @returns {Object} { win: boolean, score: number, reason: string }
 */
function checkWin(hand) {
    if (!hand || hand.length !== 5) return { win: false, score: 0, reason: '' };

    // 計算每種牌的數量
    const counts = {};
    hand.forEach(tile => counts[tile] = (counts[tile] || 0) + 1);

    // 輔助函式：檢查手牌是否包含特定組合
    const hasSubset = (subset) => {
        let tempCounts = { ...counts };
        for (let tile of subset) {
            if (!tempCounts[tile] || tempCounts[tile] === 0) return false;
            tempCounts[tile]--;
        }
        return true;
    };

    // 輔助函式：取得扣除特定組合後，剩下的牌是否為「一模一樣的對子」
    const getRemainingPair = (subset) => {
        let tempCounts = { ...counts };
        for (let tile of subset) tempCounts[tile]--;
        let remain = [];
        for (let tile in tempCounts) {
            for (let i = 0; i < tempCounts[tile]; i++) remain.push(tile);
        }
        if (remain.length === 2 && remain[0] === remain[1]) return remain[0];
        return null;
    };

    // ③ 兵兵兵兵兵 或 卒卒卒卒卒 = 10分
    if (counts['兵'] === 5) return { win: true, score: 10, reason: '兵兵兵兵兵 (10分)' };
    if (counts['卒'] === 5) return { win: true, score: 10, reason: '卒卒卒卒卒 (10分)' };

    // ① 帥＋仕＋相 或 將＋士＋象 + 另外兩張一模一樣的牌 = 4分
    if (hasSubset(['帥', '仕', '相'])) {
        let pair = getRemainingPair(['帥', '仕', '相']);
        if (pair) return { win: true, score: 4, reason: `帥仕相 + ${pair}${pair} (4分)` };
    }
    if (hasSubset(['將', '士', '象'])) {
        let pair = getRemainingPair(['將', '士', '象']);
        if (pair) return { win: true, score: 4, reason: `將士象 + ${pair}${pair} (4分)` };
    }

    // ② 俥＋傌＋炮 或 車＋馬＋包 + 另外兩張一模一樣的牌 = 3分
    if (hasSubset(['俥', '傌', '炮'])) {
        let pair = getRemainingPair(['俥', '傌', '炮']);
        if (pair) return { win: true, score: 3, reason: `俥傌炮 + ${pair}${pair} (3分)` };
    }
    if (hasSubset(['車', '馬', '包'])) {
        let pair = getRemainingPair(['車', '馬', '包']);
        if (pair) return { win: true, score: 3, reason: `車馬包 + ${pair}${pair} (3分)` };
    }

    // ⑤ 帥＋將＋兵兵兵（或卒卒卒） = 8分
    if (hasSubset(['帥', '將'])) {
        let tempCounts = { ...counts };
        tempCounts['帥']--; tempCounts['將']--;
        if (tempCounts['兵'] === 3) return { win: true, score: 8, reason: '帥將 + 兵兵兵 (8分)' };
        if (tempCounts['卒'] === 3) return { win: true, score: 8, reason: '帥將 + 卒卒卒 (8分)' };
    }

    // ④ 除了將/帥以外：任意兩張相同棋子 + 兵兵兵（或卒卒卒） = 5分
    if (counts['兵'] === 3 || counts['卒'] === 3) {
        let targetPawn = counts['兵'] === 3 ? '兵' : '卒';
        let tempCounts = { ...counts };
        tempCounts[targetPawn] -= 3; // 扣除三隻兵或卒
        
        let remain = [];
        for (let tile in tempCounts) {
            for (let i = 0; i < tempCounts[tile]; i++) remain.push(tile);
        }
        // 如果剩下兩張牌是一樣的，且不是將/帥
        if (remain.length === 2 && remain[0] === remain[1]) {
            let pair = remain[0];
            if (pair !== '帥' && pair !== '將') {
                return { win: true, score: 5, reason: `${pair}${pair} + ${targetPawn}${targetPawn}${targetPawn} (5分)` };
            }
        }
    }

    // 都沒符合
    return { win: false, score: 0, reason: '' };
}


// Socket.io 連線處理
io.on('connection', (socket) => {
    console.log(`玩家已連線: ${socket.id}`);

    // 玩家加入房間
    socket.on('join_room', (roomId, playerName) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: [],
                status: 'waiting', // waiting, playing, finished
                turnIndex: 0
            };
        }
        
        // 避免重複加入
        if (rooms[roomId].players.length < 3 && !rooms[roomId].players.find(p => p.id === socket.id)) {
            rooms[roomId].players.push({ id: socket.id, name: playerName, hand: [], score: 0 });
        }

        io.to(roomId).emit('room_update', rooms[roomId].players);

        // 人滿 3 人自動開始遊戲
        if (rooms[roomId].players.length === 3 && rooms[roomId].status === 'waiting') {
            startGame(roomId);
        }
    });

    // 開始遊戲邏輯
    function startGame(roomId) {
        let room = rooms[roomId];
        room.status = 'playing';
        room.deck = generateDeck();
        room.turnIndex = 0;

        // 發牌，每人先發 4 張
        room.players.forEach(player => {
            player.hand = [room.deck.pop(), room.deck.pop(), room.deck.pop(), room.deck.pop()];
        });

        // 廣播給房間內所有人遊戲開始，並將各自的手牌私下傳給對應玩家
        room.players.forEach(player => {
            io.to(player.id).emit('game_started', {
                hand: player.hand,
                turnIndex: room.turnIndex,
                players: room.players.map(p => ({ name: p.name, score: p.score })), // 隱藏其他人手牌
                tilesLeft: room.deck.length
            });
        });
    }

    // 玩家要求摸牌
    socket.on('draw_tile', (roomId) => {
        let room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        // 確認是否為該玩家的回合
        let currentPlayer = room.players[room.turnIndex];
        if (currentPlayer.id !== socket.id) return;

        if (room.deck.length > 0) {
            let drawnTile = room.deck.pop();
            currentPlayer.hand.push(drawnTile);

            // 回傳摸到的牌給該玩家
            socket.emit('tile_drawn', {
                tile: drawnTile,
                hand: currentPlayer.hand,
                tilesLeft: room.deck.length
            });
            
            // 廣播給其他人「剩餘牌數減少」
            socket.to(roomId).emit('other_player_drew', { tilesLeft: room.deck.length });
        } else {
            io.to(roomId).emit('game_draw', { message: '牌庫已空，流局！' });
            room.status = 'finished';
        }
    });

    // 玩家宣告胡牌 (自摸或吃別人的牌後檢查)
    socket.on('declare_win', (roomId) => {
        let room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        let player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // 呼叫核心驗證邏輯
        let result = checkWin(player.hand);

        if (result.win) {
            // 胡牌成立，立即停止本局，不用棄牌
            room.status = 'finished';
            player.score += result.score; // 加上分數

            // 廣播胡牌特效與結算畫面給所有人
            io.to(roomId).emit('game_won', {
                winnerName: player.name,
                winningHand: player.hand,
                reason: result.reason,
                scoreAdded: result.score,
                allPlayers: room.players // 傳送最新分數
            });
        } else {
            // 詐胡處理 (可選)，這裡只是單純駁回
            socket.emit('win_rejected', { message: '您的牌型不符合胡牌條件！' });
        }
    });

    // 玩家棄牌 (如果沒有胡牌)
    socket.on('discard_tile', (roomId, discardIndex) => {
        let room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        let currentPlayer = room.players[room.turnIndex];
        if (currentPlayer.id !== socket.id) return;

        // 將牌從手牌移除
        let discardedTile = currentPlayer.hand.splice(discardIndex, 1)[0];

        // 廣播這張棄牌到中央場地
        io.to(roomId).emit('tile_discarded', {
            playerName: currentPlayer.name,
            tile: discardedTile
        });

        // 換下一位玩家 (0 -> 1 -> 2 -> 0)
        room.turnIndex = (room.turnIndex + 1) % 3;
        
        io.to(roomId).emit('turn_changed', { turnIndex: room.turnIndex });
    });

    // 玩家斷線處理
    socket.on('disconnect', () => {
        console.log(`玩家斷線: ${socket.id}`);
        // 可在這裡加入清理房間的邏輯
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器已啟動： http://localhost:${PORT}`);
});