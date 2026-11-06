import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// 새 버전 배포 후 예전 화면이 남지 않게:
// - 앱이 다시 화면에 나올 때마다 서비스워커 업데이트 확인 (홈 화면 앱은 껐다 켜도 재시작이 안 될 때가 많음)
// - 새 서비스워커가 넘겨받으면(autoUpdate) 한 번 새로고침
if ('serviceWorker' in navigator) {
  var hadController = !!navigator.serviceWorker.controller;
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; } // 첫 설치는 새로고침 불필요
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  var checkUpdate = function () {
    navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update().catch(function () {}); }).catch(function () {});
  };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkUpdate(); });
  setInterval(checkUpdate, 60 * 60 * 1000);
}
