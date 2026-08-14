
(function(){
  let selectedPlan={name:'7 дней',price:'$1.99'};
  window.openPremiumPricing=function(){
    const modal=document.getElementById('rmPremiumModal');
    if(!modal)return;
    modal.classList.add('rm-open');
    modal.setAttribute('aria-hidden','false');
    document.body.classList.add('rm-premium-open');
  };
  window.closePremiumPricing=function(){
    const modal=document.getElementById('rmPremiumModal');
    if(!modal)return;
    modal.classList.remove('rm-open');
    modal.setAttribute('aria-hidden','true');
    document.body.classList.remove('rm-premium-open');
  };
  window.selectPremiumPlan=function(button){
    document.querySelectorAll('.rm-premium-plan').forEach(el=>el.classList.remove('active'));
    button.classList.add('active');
    selectedPlan={name:button.dataset.plan||'',price:button.dataset.price||''};
  };
  window.demoPremiumCheckout=function(){
    alert('Демо: выбран тариф «'+selectedPlan.name+'» за '+selectedPlan.price+'. Реальная оплата пока не подключена.');
  };
  document.addEventListener('click',function(e){
    const modal=document.getElementById('rmPremiumModal');
    if(modal && e.target===modal) window.closePremiumPricing();
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape') window.closePremiumPricing();
  });
})();
