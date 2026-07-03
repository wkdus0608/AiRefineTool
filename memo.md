작업 끝낼 때는 보통 이 정도면 됩니다:
    lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill
    brew services stop postgresql@16
다음에 다시 작업할 때:
    brew services start postgresql@16
    npm run dev

DB 끄기
    brew services stop postgresql@16
다시 켜기:
    brew services start postgresql@16
상태 확인:
    brew services list


3000번대 전체 확인:
    lsof -nP -iTCP -sTCP:LISTEN | grep ':30'
PID가 27246입니다. 이걸 종료합니다:
    kill 27246
안 꺼지면 강제 종료:
    kill -9 27246

